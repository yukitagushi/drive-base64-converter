import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import {
  buildSessionPayload,
  getSupabaseBearerToken,
  resolveStaffForRequest,
} from '../lib/api-auth';
import { getSupabaseClientWithToken } from '../lib/supabaseClient';
import { GeminiApiError, createFileStore } from '../lib/gemini';

function applyCors(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string | undefined) || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
}

function respond(res: VercelResponse, status: number, payload: Record<string, any>) {
  res.status(status).json({ source: 'api', status, ...payload });
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  try {
    if (req.method === 'GET') {
      await handleGet(req, res);
      return;
    }

    if (req.method === 'POST') {
      await handlePost(req, res);
      return;
    }

    res.setHeader('Allow', 'GET,POST,OPTIONS');
    respond(res, 405, { error: 'Method Not Allowed' });
  } catch (error: any) {
    console.error('Error in /api/file-stores:', error);
    if (handleKnownError(res, error)) {
      return;
    }
    respond(res, 500, { error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const token = getSupabaseBearerToken(req);
  if (!token) {
    respond(res, 401, { error: '認証が必要です。' });
    return;
  }

  const admin = getSupabaseAdmin();
  const staff = await resolveStaffForRequest(admin, req);
  if (!staff) {
    respond(res, 403, { error: 'スタッフ情報が見つかりません。' });
    return;
  }

  if (!staff.officeId) {
    respond(res, 403, { error: '事業所情報が見つかりません。' });
    return;
  }

  const supabase = getSupabaseClientWithToken(token);

  const { data, error } = await supabase
    .from('file_stores')
    .select('id, organization_id, office_id, gemini_store_name, display_name, description, created_by, created_at')
    .eq('office_id', staff.officeId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const storeIds = (data || []).map((row) => row.id);
  const metrics: Record<
    string,
    {
      count: number;
      size: number;
    }
  > = {};

  if (storeIds.length) {
    const { data: files, error: fileError } = await supabase
      .from('file_store_files')
      .select('file_store_id, size_bytes')
      .in('file_store_id', storeIds);
    if (fileError) {
      console.error('file-stores metrics error:', fileError.message);
    } else {
      for (const row of files || []) {
        const id = row.file_store_id;
        if (!metrics[id]) {
          metrics[id] = { count: 0, size: 0 };
        }
        metrics[id].count += 1;
        metrics[id].size += Number(row.size_bytes || 0);
      }
    }
  }

  const items = (data || []).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    geminiStoreName: row.gemini_store_name,
    displayName: row.display_name,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at,
    fileCount: metrics[row.id]?.count || 0,
    sizeBytes: metrics[row.id]?.size || 0,
  }));

  let sessionPayload = null;
  sessionPayload = await buildSessionPayload(admin, staff).catch((err: any) => {
    console.error('file-stores session build error:', err?.message || err);
    return null;
  });

  res.status(200).json({
    items,
    session: sessionPayload?.session,
    threads: sessionPayload?.threads,
  });
}

async function handlePost(req: VercelRequest, res: VercelResponse) {
  const token = getSupabaseBearerToken(req);
  if (!token) {
    respond(res, 401, { error: '認証が必要です。' });
    return;
  }

  const admin = getSupabaseAdmin();
  const supabase = getSupabaseClientWithToken(token);
  let body: any = {};
  try {
    if (typeof req.body === 'string') {
      body = req.body ? JSON.parse(req.body) : {};
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }
  } catch (error: any) {
    respond(res, 400, { error: 'JSON 形式で送信してください。' });
    return;
  }
  const staff = await resolveStaffForRequest(admin, req);

  if (!staff?.officeId) {
    respond(res, 403, { error: '事業所に紐づいたスタッフ情報が見つかりません。' });
    return;
  }

  const displayName = String(body.displayName || '').trim();
  if (!displayName) {
    respond(res, 400, { error: 'displayName は必須です。' });
    return;
  }

  const description = typeof body.description === 'string' ? body.description : null;

  const store = await createFileStore(displayName);

  if (!store.storeName) {
    console.error('Gemini did not return a store name.');
    respond(res, 502, { error: 'Gemini ストアの作成結果に識別子が含まれていません。' });
    return;
  }

  const insertPayload = {
    id: body.id && typeof body.id === 'string' ? body.id : undefined,
    office_id: staff.officeId,
    organization_id: staff.organizationId,
    gemini_store_name: store.storeName,
    display_name: displayName,
    description,
    created_by: staff.id,
  };

  const { data, error } = await supabase
    .from('file_stores')
    .insert(insertPayload)
    .select('id, organization_id, office_id, gemini_store_name, display_name, description, created_by, created_at')
    .single();

  if (error) {
    console.error('Supabase store insert error:', error.message);
    if (error.code === '23505') {
      respond(res, 409, { error: '同じストアがすでに存在します。' });
      return;
    }
    throw new Error(error.message);
  }

  res.status(201).json({
    item: {
      id: data.id,
      organizationId: data.organization_id,
      officeId: data.office_id,
      geminiStoreName: data.gemini_store_name,
      displayName: data.display_name,
      description: data.description,
      createdBy: data.created_by,
      createdAt: data.created_at,
      fileCount: 0,
      sizeBytes: 0,
    },
  });
}

function handleKnownError(res: VercelResponse, error: any): boolean {
  if (error instanceof GeminiApiError) {
    const status = error.status ?? 500;
    res.status(status).json({
      source: 'gemini',
      error: error.message,
      status,
      debugId: error.debugId ?? null,
    });
    return true;
  }
  return false;
}
