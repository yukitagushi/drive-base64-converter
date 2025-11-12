import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import {
  getSupabaseBearerToken,
  resolveStaffForRequest,
  isSupabaseConfigured,
} from '../lib/api-auth';
import { GeminiApiError } from '../lib/gemini';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GeminiKnowledgeBase } = require('../lib/gemini.js');

const knowledgeBase = new GeminiKnowledgeBase({});
let knowledgeInit: Promise<void> | null = null;

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

async function ensureKnowledgeReady() {
  if (!knowledgeInit) {
    knowledgeInit = knowledgeBase.init();
  }
  try {
    await knowledgeInit;
  } catch (error) {
    knowledgeInit = null;
    throw error;
  }
}

function generateThreadTitle(text: string): string {
  if (!text) {
    return '新しい質問';
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '新しい質問';
  }
  const snippet = normalized.slice(0, 28);
  return normalized.length > 28 ? `${snippet}…` : snippet;
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

function mapThread(row: ThreadRow) {
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
) {
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
      throw new Error(error.message);
    }
    if (data && data.office_id === staff.officeId) {
      return mapThread(data as ThreadRow);
    }
  }

  const { data, error } = await admin
    .from('chat_threads')
    .insert({
      office_id: staff.officeId,
      staff_id: staff.id,
      title: title || '新しい質問',
    })
    .select('id, office_id, staff_id, title, created_at, updated_at')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return mapThread(data as ThreadRow);
}

async function recordMessages(options: {
  admin: ReturnType<typeof getSupabaseAdmin>;
  threadId: string;
  staffId: string;
  question: string;
  answer: string;
  context: any;
}) {
  const { admin, threadId, staffId, question, answer, context } = options;
  const rows = [
    {
      thread_id: threadId,
      author_staff_id: staffId,
      role: 'user',
      content: question,
      metadata: { kind: 'question' },
    },
    {
      thread_id: threadId,
      author_staff_id: staffId,
      role: 'assistant',
      content: answer,
      metadata: { kind: 'answer', context },
    },
  ];

  const { error } = await admin.from('chat_messages').insert(rows);
  if (error) {
    throw new Error(error.message);
  }

  await admin
    .from('chat_threads')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', threadId);
}

async function fetchThreadSummaries(
  admin: ReturnType<typeof getSupabaseAdmin>,
  officeId: string,
  focusThreadId?: string | null
) {
  const { data, error } = await admin
    .from('chat_thread_summaries')
    .select('id, office_id, staff_id, title, created_at, updated_at, last_message')
    .eq('office_id', officeId)
    .order('updated_at', { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(error.message);
  }

  const items = (data || []).map((row: any) => ({
    id: row.id,
    officeId: row.office_id,
    staffId: row.staff_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessage: row.last_message || null,
  }));

  const focus = focusThreadId ? items.find((item) => item.id === focusThreadId) || null : null;
  return { items, focus };
}

function normalizeHistory(raw: any): Array<{ role: string; content: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => ({
      role: typeof entry?.role === 'string' ? entry.role : 'user',
      content: typeof entry?.content === 'string' ? entry.content : '',
    }))
    .filter((entry) => entry.content);
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
    if (typeof req.body === 'string') {
      body = req.body ? JSON.parse(req.body) : {};
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) {
      respond(res, 400, { error: 'query は必須です。' });
      return;
    }

    await ensureKnowledgeReady();
    if (!knowledgeBase.isReady) {
      respond(res, 503, { error: 'ナレッジベースの初期化が完了していません。' });
      return;
    }

    const history = normalizeHistory(body.history);
    const supabaseEnabled = isSupabaseConfigured();
    const token = getSupabaseBearerToken(req);
    const admin = supabaseEnabled ? getSupabaseAdmin() : null;
    const staff = supabaseEnabled && admin ? await resolveStaffForRequest(admin, req) : null;

    if (supabaseEnabled && (!token || !staff)) {
      respond(res, 403, { error: 'チャットを利用するにはログインしてください。' });
      return;
    }

    const sessionPayload = {
      organizationId: staff?.organizationId || body.session?.organizationId || null,
      officeId: staff?.officeId || body.session?.officeId || null,
      staffId: staff?.id || body.session?.staffId || null,
      threadId: null as string | null,
      supabaseConfigured: supabaseEnabled,
    };

    let thread: any = null;
    let threads: any[] = [];

    if (supabaseEnabled && admin && staff?.officeId) {
      const requestedThreadId = typeof body.session?.threadId === 'string' ? body.session.threadId : null;
      thread = await ensureThread(admin, staff as StaffContext, requestedThreadId, generateThreadTitle(query));
      sessionPayload.threadId = thread?.id || null;

      try {
        const chatResult = await knowledgeBase.chat({ query, history });

        if (thread?.id && staff?.id) {
          await recordMessages({
            admin,
            threadId: thread.id,
            staffId: staff.id,
            question: query,
            answer: chatResult.answer,
            context: chatResult.context,
          });

          const { items, focus } = await fetchThreadSummaries(admin, staff.officeId, thread.id);
          threads = items;
          if (focus) {
            thread = focus;
          }
        }

        respond(res, 200, {
          answer: chatResult.answer,
          context: chatResult.context,
          thread,
          threads,
          session: sessionPayload,
        });
        return;
      } catch (error: any) {
        if (error instanceof GeminiApiError) {
          respond(res, error.status || 500, {
            error: error.message,
            debugId: error.debugId || null,
            source: 'gemini',
            status: error.status || 500,
          });
          return;
        }
        throw error;
      }
    }

    // Supabase 未設定の場合はチャットのみ応答
    try {
      const chatResult = await knowledgeBase.chat({ query, history });
      respond(res, 200, {
        answer: chatResult.answer,
        context: chatResult.context,
        thread: null,
        threads: [],
        session: sessionPayload,
      });
    } catch (error: any) {
      if (error instanceof GeminiApiError) {
        respond(res, error.status || 500, {
          error: error.message,
          debugId: error.debugId || null,
          source: 'gemini',
          status: error.status || 500,
        });
        return;
      }
      throw error;
    }
  } catch (error: any) {
    console.error('Error in /api/chat:', error);
    if (error instanceof GeminiApiError) {
      respond(res, error.status || 500, {
        error: error.message,
        debugId: error.debugId || null,
        source: 'gemini',
        status: error.status || 500,
      });
      return;
    }
    respond(res, 500, { error: error?.message || 'Internal Server Error' });
  }
}
