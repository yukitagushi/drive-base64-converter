import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import {
  buildGuestSessionPayload,
  buildSessionPayload,
  getSupabaseBearerToken,
  resolveStaffContext,
  resolveUserFromToken,
} from '../lib/api-auth';

/**
 * /api/session synchronises the UI session state with Supabase membership.
 * Responsibilities:
 *   - GET: return the user's resolved office/staff context and thread summaries.
 *   - POST: accept partial session updates (office/staff/thread) and respond with the
 *           recalculated session payload.
 *   - Always return JSON responses (no FUNCTION_INVOCATION_FAILED) and surface
 *     Supabase errors for debugging.
 */

const SESSION_API_NAME = '/api/session';
const isProduction = process.env.NODE_ENV === 'production';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET,POST,OPTIONS');
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    await handleGetSession(req, res);
    return;
  }

  if (req.method === 'POST') {
    await handlePostSession(req, res);
    return;
  }

  res.setHeader('Allow', 'GET,POST,OPTIONS');
  respond(res, 405, { error: 'Method Not Allowed' }, { stage: 'method_not_allowed', method: req.method });
}

async function handleGetSession(req: VercelRequest, res: VercelResponse) {
  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch (error: any) {
    logSessionError('admin_init', 'Supabase admin init failed for GET', error);
    respond(res, 200, buildGuestSessionPayload());
    return;
  }

  const token = getSupabaseBearerToken(req);
  if (!token) {
    respond(res, 200, buildGuestSessionPayload());
    return;
  }

  try {
    const user = await resolveUserFromToken(admin, token);
    const staff = await resolveStaffContext(admin, { userId: user.id, email: user.email });
    if (!staff) {
      respond(res, 200, buildGuestSessionPayload());
      return;
    }
    const payload = await buildSessionPayload(admin, staff);
    respond(res, 200, payload);
  } catch (error: any) {
    logSessionError('get', 'Failed to build session payload', error);
    respond(
      res,
      401,
      { error: error?.message || 'セッション情報の取得に失敗しました。' },
      { stage: 'resolve_session' }
    );
  }
}

async function handlePostSession(req: VercelRequest, res: VercelResponse) {
  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch (error: any) {
    logSessionError('admin_init', 'Supabase admin init failed for POST', error);
    respond(
      res,
      503,
      { error: 'Supabase が利用できません。' },
      { stage: 'admin_init' }
    );
    return;
  }

  let body: any;
  try {
    body = parseBody(req);
  } catch (error: any) {
    respond(res, 400, { error: 'Invalid JSON body' }, { stage: 'parse_body' });
    return;
  }

  const token = getSupabaseBearerToken(req);
  if (!token) {
    respond(res, 401, { error: '認証が必要です。' }, { stage: 'auth_missing' });
    return;
  }

  let user;
  try {
    user = await resolveUserFromToken(admin, token);
  } catch (error: any) {
    logSessionError('auth', 'Failed to resolve user from token', error);
    respond(res, 401, { error: 'セッション情報の取得に失敗しました。' }, { stage: 'user_lookup' });
    return;
  }

  const staff = await resolveStaffContext(admin, { userId: user.id, email: user.email });
  if (!staff) {
    respond(res, 403, { error: 'スタッフ情報が見つかりません。' }, { stage: 'staff_missing' });
    return;
  }

  let payload;
  try {
    payload = await buildSessionPayload(admin, staff);
  } catch (error: any) {
    logSessionError('session', 'Failed to build base session payload', error);
    respond(res, 500, { error: 'セッション情報の取得に失敗しました。' }, { stage: 'build_session' });
    return;
  }

  const hierarchy = Array.isArray(payload.hierarchy) ? payload.hierarchy : [];
  const nextSession = { ...payload.session };

  const requestedOfficeId = typeof body.officeId === 'string' ? body.officeId.trim() : undefined;
  if (requestedOfficeId !== undefined) {
    if (!requestedOfficeId) {
      nextSession.officeId = null;
    } else {
      const officeExists = hierarchy.some((org: any) => (org.offices || []).some((office: any) => office.id === requestedOfficeId));
      if (!officeExists) {
        respond(
          res,
          400,
          { error: 'missing_context', detail: '指定された事業所にアクセスできません。' },
          { stage: 'office_validation', officeId: requestedOfficeId }
        );
        return;
      }
      nextSession.officeId = requestedOfficeId;
    }
  }

  const activeOfficeId = nextSession.officeId;
  const availableStaff: any[] = [];
  hierarchy.forEach((org: any) => {
    (org.offices || []).forEach((office: any) => {
      if (!activeOfficeId || office.id === activeOfficeId) {
        (office.staff || []).forEach((member: any) => availableStaff.push({ ...member, officeId: office.id }));
      }
    });
  });

  const requestedStaffId = typeof body.staffId === 'string' ? body.staffId.trim() : undefined;
  if (requestedStaffId !== undefined) {
    if (!requestedStaffId) {
      nextSession.staffId = null;
    } else {
      const staffExists = availableStaff.some((member) => member.id === requestedStaffId);
      if (!staffExists) {
        respond(
          res,
          400,
          { error: 'missing_context', detail: '指定されたスタッフにアクセスできません。' },
          { stage: 'staff_validation', staffId: requestedStaffId }
        );
        return;
      }
      nextSession.staffId = requestedStaffId;
    }
  }

  let threads: any[] = [];
  try {
    threads = await fetchThreadsForOffice(admin, nextSession.officeId);
  } catch (error: any) {
    logSessionError('threads', 'Failed to load threads for office', error, { officeId: nextSession.officeId });
    threads = [];
  }

  const requestedThreadId = typeof body.threadId === 'string' ? body.threadId.trim() : undefined;
  if (requestedThreadId !== undefined) {
    if (!requestedThreadId) {
      nextSession.threadId = null;
    } else {
      const threadExists = threads.some((thread) => thread.id === requestedThreadId);
      if (!threadExists) {
        respond(
          res,
          404,
          { error: 'missing_context', detail: '指定されたスレッドが見つかりません。' },
          { stage: 'thread_validation', threadId: requestedThreadId }
        );
        return;
      }
      nextSession.threadId = requestedThreadId;
    }
  }

  respond(res, 200, {
    supabaseConfigured: payload.supabaseConfigured,
    hierarchy: payload.hierarchy,
    session: nextSession,
    threads,
  });
}
function withDebug(payload: Record<string, any>, debug: Record<string, any> | null): Record<string, any> {
  if (!isProduction && debug && Object.keys(debug).length > 0) {
    return { ...payload, debug };
  }
  return payload;
}

function respond(
  res: VercelResponse,
  status: number,
  payload: Record<string, any>,
  debug: Record<string, any> | null = null
) {
  res.status(status).json(withDebug({ source: 'api', status, ...payload }, debug));
}

function logSessionError(stage: string, message: string, error: unknown, context: Record<string, any> = {}) {
  console.error(`${SESSION_API_NAME} ${stage} error: ${message}`, {
    api: SESSION_API_NAME,
    stage,
    ...context,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error,
  });
}

async function fetchThreadsForOffice(admin: any, officeId: string | null) {
  if (!officeId) {
    return [];
  }
  const { data, error } = await admin
    .from('chat_thread_summaries')
    .select('id,office_id,staff_id,title,created_at,updated_at,last_message')
    .eq('office_id', officeId)
    .order('updated_at', { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(error.message || 'スレッド一覧の取得に失敗しました。');
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    officeId: row.office_id,
    staffId: row.staff_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessage: row.last_message || null,
  }));
}

function parseBody(req: VercelRequest): any {
  if (typeof req.body === 'string') {
    try {
      return req.body ? JSON.parse(req.body) : {};
    } catch (error) {
      throw new Error('Invalid JSON body');
    }
  }
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  return {};
}

