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
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
}

function respond(res: VercelResponse, status: number, payload: Record<string, any>) {
  res.status(status).json({ source: 'api', status, ...payload });
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
      console.error('supabase error', {
        table: 'chat_threads',
        operation: 'select',
        error,
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
    console.error('supabase error', {
      table: 'chat_threads',
      operation: 'insert',
      error,
    });
    throw new SupabaseQueryError('chat_threads', 'insert', error);
  }

  return mapThreadRow(data as ThreadRow);
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
    console.error('supabase error', {
      table: 'chat_messages',
      operation: 'insert',
      error,
    });
    throw new SupabaseQueryError('chat_messages', 'insert', error);
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
    console.error('supabase error', {
      table: 'chat_messages',
      operation: 'select',
      error,
    });
    throw new SupabaseQueryError('chat_messages', 'select', error);
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
    console.error('supabase error', {
      table: 'chat_threads',
      operation: 'update',
      error,
    });
    throw new SupabaseQueryError('chat_threads', 'update', error);
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,OPTIONS');
    respond(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    let body: any = {};
    try {
      body = parseBody(req);
    } catch (error: any) {
      respond(res, 400, { error: '無効な JSON です。' });
      return;
    }

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      respond(res, 400, { error: 'message は必須です。' });
      return;
    }

    const requestedThreadId = typeof body.threadId === 'string' ? body.threadId.trim() || null : null;

    if (!isSupabaseConfigured()) {
      respond(res, 503, { error: 'Supabase が設定されていません。' });
      return;
    }

    const token = getSupabaseBearerToken(req);
    if (!token) {
      respond(res, 401, { error: 'チャットを利用するにはログインしてください。' });
      return;
    }

    const admin = getSupabaseAdmin();
    const staff = await resolveStaffForRequest(admin, req);

    if (!staff || !staff.id) {
      respond(res, 403, { error: 'スタッフ情報が確認できません。' });
      return;
    }

    if (!staff.officeId) {
      respond(res, 403, { error: '所属する事業所が設定されていません。' });
      return;
    }

    try {
      ensureGeminiEnvironment({ requireProject: false, requireLocation: false });
    } catch (envError: any) {
      respond(res, 500, {
        error:
          envError?.message || 'Gemini の環境変数 (GEMINI_API_KEY または GOOGLE_API_KEY) を確認してください。',
      });
      return;
    }

    const thread = await ensureThread(admin, staff as StaffContext, requestedThreadId, generateThreadTitle(message));
    if (!thread) {
      respond(res, 403, { error: 'チャットスレッドを作成できませんでした。' });
      return;
    }

    await insertMessage({
      admin,
      threadId: thread.id,
      staffId: staff.id,
      role: 'user',
      content: message,
    });

    const historyRows = await loadThreadMessages(admin, thread.id);
    const geminiMessages = toGeminiMessages(historyRows);

    const chatResult = await generateChatResponse({ messages: geminiMessages });
    const assistantContent = chatResult.text?.trim() || DEFAULT_ASSISTANT_FALLBACK;

    const assistantMetadata = chatResult.usage ? { usage: chatResult.usage } : null;
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
    console.error('api/chat failed', error);
    if (!res.headersSent) {
      const supabaseErrorPayload = error instanceof SupabaseQueryError ? serializeSupabaseErrorPayload(error) : null;
      res.status(500).json({
        source: 'api',
        error: 'chat_failed',
        supabaseError: supabaseErrorPayload,
        geminiError: serializeGeminiError(error),
      });
    }
  }
}
