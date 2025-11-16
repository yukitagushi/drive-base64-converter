import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  getSupabaseBearerToken,
  resolveStaffForRequest,
  isSupabaseConfigured,
} from '../lib/api-auth';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import {
  GeminiApiError,
  ensureGeminiEnvironment,
  generateChatResponse,
  type GeminiChatMessage,
} from '../lib/gemini';

/**
 * /api/chat delivers the authenticated conversational experience backed by Supabase state
 * and Gemini File Search. The handler must:
 *   - Validate the caller's Supabase identity and resolve the associated staff/office context.
 *   - Persist every user and assistant turn to chat_threads/chat_messages.
 *   - Invoke Gemini with File Search context and return the aggregated transcript.
 *   - Surface Supabase/Gemini failures as structured JSON instead of crashing the function.
 *   - HTTP status policy: 200 on success, 400 for missing context (no store/office/thread),
 *     401/403 for auth failures, and 500 only when Supabase or Gemini return unexpected errors.
 */

const CHAT_API_NAME = '/api/chat';
const isProduction = process.env.NODE_ENV === 'production';

class SupabaseQueryError extends Error {
  table: string;
  operation: string;
  supabaseError: any;

  constructor(table: string, operation: string, supabaseError: any) {
    super(supabaseError?.message || `Supabase ${operation} failed for ${table}`);
    this.name = 'SupabaseQueryError';
    this.table = table;
    this.operation = operation;
    this.supabaseError = supabaseError ?? null;
  }
}

interface StaffContext {
  id: string;
  officeId: string | null;
  organizationId: string | null;
}

interface ThreadRow {
  id: string;
  office_id: string | null;
  staff_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  metadata: any;
  created_at: string;
}

interface FileStoreRow {
  id: string;
  office_id: string | null;
  organization_id: string | null;
  gemini_store_name: string;
  display_name: string | null;
}

interface ThreadSummary {
  id: string;
  officeId: string | null;
  staffId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface InsertMessageParams {
  admin: ReturnType<typeof getSupabaseAdmin>;
  threadId: string;
  staffId: string;
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, any> | null;
}

const DEFAULT_ASSISTANT_FALLBACK = '申し訳ありませんが、回答を生成できませんでした。';

function applyCors(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string | undefined) || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
}

function respond(
  res: VercelResponse,
  status: number,
  payload: Record<string, any>,
  debug: Record<string, any> | null = null
) {
  const body = { source: 'api', status, ...payload };
  res.status(status).json(withDebug(body, debug));
}

function compactGeminiBody(body: any): any {
  if (body == null) {
    return null;
  }
  if (typeof body === 'string') {
    return body.length > 2000 ? `${body.slice(0, 2000)}…` : body;
  }
  try {
    const serialized = JSON.stringify(body);
    if (serialized.length > 2000) {
      return `${serialized.slice(0, 2000)}…`;
    }
    return JSON.parse(serialized);
  } catch {
    return body;
  }
}

function serializeGeminiError(error: unknown): Record<string, any> {
  if (error instanceof GeminiApiError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status ?? null,
      debugId: error.debugId ?? null,
      body: compactGeminiBody(error.body),
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { value: error };
}

function serializeSupabaseErrorPayload(error: SupabaseQueryError | null): Record<string, any> | null {
  if (!error) {
    return null;
  }

  const raw = error.supabaseError || {};
  const sanitized = typeof raw === 'object' && raw !== null
    ? {
        message: raw.message ?? null,
        details: raw.details ?? null,
        hint: raw.hint ?? null,
        code: raw.code ?? null,
      }
    : { message: raw };

  return {
    table: error.table,
    operation: error.operation,
    ...sanitized,
  };
}

function logChatError(stage: string, message: string, error: unknown, context: Record<string, any> = {}) {
  console.error(`${CHAT_API_NAME} ${stage} error: ${message}`, {
    api: CHAT_API_NAME,
    stage,
    ...context,
    error:
      error instanceof SupabaseQueryError
        ? serializeSupabaseErrorPayload(error)
        : error instanceof GeminiApiError
        ? serializeGeminiError(error)
        : error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error,
  });
}

function withDebug(payload: Record<string, any>, debug: Record<string, any> | null): Record<string, any> {
  if (!isProduction && debug && Object.keys(debug).length > 0) {
    return { ...payload, debug };
  }
  return payload;
}

function generateThreadTitle(text: string): string {
  if (!text) {
    return '新しい会話';
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '新しい会話';
  }
  const snippet = normalized.slice(0, 40);
  return normalized.length > 40 ? `${snippet}…` : snippet;
}

function mapThreadRow(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    officeId: row.office_id,
    staffId: row.staff_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ensureThread(
  admin: ReturnType<typeof getSupabaseAdmin>,
  staff: StaffContext,
  requestedThreadId: string | null,
  title: string
): Promise<ThreadSummary | null> {
  if (!staff.officeId) {
    return null;
  }

  if (requestedThreadId) {
    const { data, error } = await admin
      .from('chat_threads')
      .select('id, office_id, staff_id, title, created_at, updated_at')
      .eq('id', requestedThreadId)
      .maybeSingle();

    if (error) {
      logChatError('supabase', 'Failed to load requested chat thread', new SupabaseQueryError('chat_threads', 'select', error), {
        table: 'chat_threads',
        operation: 'select',
        threadId: requestedThreadId,
      });
      throw new SupabaseQueryError('chat_threads', 'select', error);
    }

    if (data && data.office_id === staff.officeId) {
      return mapThreadRow(data as ThreadRow);
    }
  }

  const { data, error } = await admin
    .from('chat_threads')
    .insert({
      office_id: staff.officeId,
      staff_id: staff.id,
      title: title || '新しい会話',
    })
    .select('id, office_id, staff_id, title, created_at, updated_at')
    .single();

  if (error || !data) {
    const wrapped = new SupabaseQueryError('chat_threads', 'insert', error);
    logChatError('supabase', 'Failed to insert new chat thread', wrapped, {
      officeId: staff.officeId,
      staffId: staff.id,
    });
    throw wrapped;
  }

  return mapThreadRow(data as ThreadRow);
}

async function resolveFileSearchStore(
  admin: ReturnType<typeof getSupabaseAdmin>,
  staff: StaffContext
): Promise<FileStoreRow | null> {
  if (!staff.officeId) {
    return null;
  }

  const selectColumns = 'id, office_id, organization_id, gemini_store_name, display_name';

  const attempt = async (column: 'office_id' | 'organization_id', value: string | null) => {
    if (!value) {
      return null;
    }
    const { data, error } = await admin
      .from('file_stores')
      .select(selectColumns)
      .eq(column, value)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      const wrapped = new SupabaseQueryError('file_stores', 'select', error);
      logChatError('supabase', 'Failed to resolve file store for chat', wrapped, {
        column,
        value,
      });
      throw wrapped;
    }

    if (!data) {
      return null;
    }

    return data as FileStoreRow;
  };

  const officeStore = await attempt('office_id', staff.officeId);
  if (officeStore) {
    return officeStore;
  }

  if (staff.organizationId) {
    const organizationStore = await attempt('organization_id', staff.organizationId);
    if (organizationStore) {
      return organizationStore;
    }
  }

  return null;
}

async function insertMessage(params: InsertMessageParams): Promise<MessageRow> {
  const payload = {
    thread_id: params.threadId,
    author_staff_id: params.staffId,
    role: params.role,
    content: params.content,
    metadata: params.metadata ?? null,
  };

  const { data, error } = await params.admin
    .from('chat_messages')
    .insert(payload)
    .select('id, thread_id, role, content, metadata, created_at')
    .single();

  if (error || !data) {
    const wrapped = new SupabaseQueryError('chat_messages', 'insert', error);
    logChatError('supabase', 'Failed to insert chat message', wrapped, {
      threadId: params.threadId,
      role: params.role,
    });
    throw wrapped;
  }

  return data as MessageRow;
}

async function loadThreadMessages(admin: ReturnType<typeof getSupabaseAdmin>, threadId: string): Promise<MessageRow[]> {
  const { data, error } = await admin
    .from('chat_messages')
    .select('id, thread_id, role, content, metadata, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });

  if (error) {
    const wrapped = new SupabaseQueryError('chat_messages', 'select', error);
    logChatError('supabase', 'Failed to load chat history', wrapped, {
      threadId,
    });
    throw wrapped;
  }

  return (data || []) as MessageRow[];
}

function mapMessageResponse(row: MessageRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? null,
    createdAt: row.created_at,
  };
}

function toGeminiMessages(rows: MessageRow[]): GeminiChatMessage[] {
  return rows
    .map((row) => {
      const role = row.role === 'assistant' ? 'assistant' : row.role === 'system' ? 'system' : 'user';
      return {
        role,
        content: row.content,
      } as GeminiChatMessage;
    })
    .filter((message) => Boolean(message.content));
}

async function touchThread(admin: ReturnType<typeof getSupabaseAdmin>, threadId: string) {
  const { error } = await admin
    .from('chat_threads')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', threadId);

  if (error) {
    const wrapped = new SupabaseQueryError('chat_threads', 'update', error);
    logChatError('supabase', 'Failed to update chat thread timestamp', wrapped, {
      threadId,
    });
    throw wrapped;
  }
}

function parseBody(req: VercelRequest): any {
  if (typeof req.body === 'string') {
    return req.body ? JSON.parse(req.body) : {};
  }
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  return {};
}

async function handleThreadHistoryRequest(
  req: VercelRequest,
  res: VercelResponse,
  admin: ReturnType<typeof getSupabaseAdmin>,
  staff: StaffContext,
  catchContext: Record<string, any>,
): Promise<void> {
  const query: Record<string, string | string[] | undefined> = (req.query || {}) as any;
  const rawThreadId =
    typeof query.threadId === 'string'
      ? query.threadId
      : Array.isArray(query.threadId)
      ? query.threadId[0]
      : typeof query.thread_id === 'string'
      ? query.thread_id
      : Array.isArray(query.thread_id)
      ? query.thread_id[0]
      : '';
  const threadId = (rawThreadId || '').trim();
  if (!threadId) {
    respond(res, 400, { error: 'thread_id_required' }, { stage: 'thread_lookup', ...catchContext });
    return;
  }

  const { data, error } = await admin
    .from('chat_threads')
    .select('id, office_id, staff_id, title, created_at, updated_at')
    .eq('id', threadId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    const wrapped = new SupabaseQueryError('chat_threads', 'select', error);
    logChatError('supabase', 'Failed to load requested chat thread', wrapped, { threadId, ...catchContext });
    throw wrapped;
  }

  if (!data) {
    respond(res, 404, { error: 'thread_not_found' }, { stage: 'thread_lookup', ...catchContext });
    return;
  }

  if (data.office_id && staff.officeId && data.office_id !== staff.officeId) {
    respond(res, 403, { error: 'forbidden' }, { stage: 'thread_lookup', ...catchContext });
    return;
  }

  catchContext.threadId = threadId;

  const rows = await loadThreadMessages(admin, threadId);
  const messages = rows.map(mapMessageResponse);

  respond(res, 200, {
    threadId,
    thread: mapThreadRow(data as ThreadRow),
    messages,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const isGetRequest = req.method === 'GET';

  if (req.method !== 'POST' && !isGetRequest) {
    res.setHeader('Allow', 'GET,POST,OPTIONS');
    respond(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const catchContext: Record<string, any> = {};
  try {
    if (!isSupabaseConfigured()) {
      respond(res, 503, { error: 'Supabase が設定されていません。' }, { stage: 'supabase_config' });
      return;
    }

    const token = getSupabaseBearerToken(req);
    if (!token) {
      respond(res, 401, { error: 'チャットを利用するにはログインしてください。' }, { stage: 'auth_missing' });
      return;
    }

    const admin = getSupabaseAdmin();
    const staff = await resolveStaffForRequest(admin, req);

    if (!staff || !staff.id) {
      respond(res, 403, { error: 'スタッフ情報が確認できません。' }, { stage: 'staff_missing' });
      return;
    }

    catchContext.staffId = staff.id;
    catchContext.officeId = staff.officeId;
    catchContext.organizationId = staff.organizationId;

    if (!staff.officeId) {
      respond(res, 403, { error: '所属する事業所が設定されていません。' }, { stage: 'office_missing', ...catchContext });
      return;
    }

    if (isGetRequest) {
      await handleThreadHistoryRequest(req, res, admin, staff as StaffContext, catchContext);
      return;
    }

    let body: any = {};
    try {
      body = parseBody(req);
    } catch (error: any) {
      respond(res, 400, { error: '無効な JSON です。' }, { stage: 'parse_body' });
      return;
    }

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      respond(res, 400, { error: 'message は必須です。' }, { stage: 'validate_message' });
      return;
    }

    const requestedThreadId = typeof body.threadId === 'string' ? body.threadId.trim() || null : null;

    try {
      ensureGeminiEnvironment({ requireProject: false, requireLocation: false });
    } catch (envError: any) {
      logChatError('configuration', 'Gemini environment validation failed', envError, catchContext);
      respond(
        res,
        500,
        {
          error:
            envError?.message || 'Gemini の環境変数 (GEMINI_API_KEY または GOOGLE_API_KEY) を確認してください。',
          geminiError: serializeGeminiError(envError),
        },
        { stage: 'gemini_env', ...catchContext }
      );
      return;
    }

    const store = await resolveFileSearchStore(admin, staff as StaffContext);
    if (!store) {
      logChatError('context', 'No file store available for chat', null, catchContext);
      respond(
        res,
        400,
        {
          error: 'missing_context',
          detail: '所属する事業所または組織に紐づく Gemini File Search ストアが見つかりません。',
        },
        { stage: 'resolve_store', ...catchContext }
      );
      return;
    }
    catchContext.geminiStoreName = store.gemini_store_name;
    catchContext.fileStoreId = store.id;

    const thread = await ensureThread(admin, staff as StaffContext, requestedThreadId, generateThreadTitle(message));
    if (!thread) {
      respond(res, 403, { error: 'チャットスレッドを作成できませんでした。' }, { stage: 'ensure_thread', ...catchContext });
      return;
    }
    catchContext.threadId = thread.id;

    await insertMessage({
      admin,
      threadId: thread.id,
      staffId: staff.id,
      role: 'user',
      content: message,
    });

    const historyRows = await loadThreadMessages(admin, thread.id);
    const geminiMessages = toGeminiMessages(historyRows);
    const systemInstruction = [
      'あなたは社内のナレッジアシスタントです。',
      `Gemini File Search ストア「${store.display_name || store.gemini_store_name}」(ID: ${store.gemini_store_name}) に保存されたドキュメントを検索しながら日本語で回答してください。`,
      '参照情報が不十分な場合はその旨を正直に伝えてください。',
    ].join('\n');

    let chatResult;
    try {
      chatResult = await generateChatResponse({
        messages: geminiMessages,
        systemInstruction,
      });
    } catch (geminiError: any) {
      const serializedGeminiError = serializeGeminiError(geminiError);
      logChatError('gemini', 'Gemini chat generation failed', geminiError, {
        ...catchContext,
        geminiError: serializedGeminiError,
      });
      respond(
        res,
        500,
        {
          error: 'chat_failed',
          supabaseError: null,
          geminiError: serializedGeminiError,
        },
        { stage: 'gemini_chat', ...catchContext }
      );
      return;
    }
    const assistantContent = chatResult.text?.trim() || DEFAULT_ASSISTANT_FALLBACK;

    const assistantMetadata = chatResult.usage
      ? { usage: chatResult.usage, fileSearchStore: store.gemini_store_name }
      : { fileSearchStore: store.gemini_store_name };
    await insertMessage({
      admin,
      threadId: thread.id,
      staffId: staff.id,
      role: 'assistant',
      content: assistantContent,
      metadata: assistantMetadata,
    });

    await touchThread(admin, thread.id);

    const finalRows = await loadThreadMessages(admin, thread.id);
    const messages = finalRows.map(mapMessageResponse);

    respond(res, 200, {
      threadId: thread.id,
      messages,
      usage: chatResult.usage || null,
    });
  } catch (error: any) {
    logChatError('handler', 'api/chat failed', error, catchContext);
    if (!res.headersSent) {
      const supabaseErrorPayload = error instanceof SupabaseQueryError ? serializeSupabaseErrorPayload(error) : null;
      respond(
        res,
        500,
        {
          error: 'chat_failed',
          supabaseError: supabaseErrorPayload,
          geminiError: serializeGeminiError(error),
        },
        { stage: 'handler_catch', ...catchContext }
      );
    }
  }
}
