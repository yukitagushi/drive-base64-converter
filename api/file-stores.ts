import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import {
  buildSessionPayload,
  getSupabaseBearerToken,
  resolveStaffForRequest,
} from '../lib/api-auth';
import { getSupabaseClientWithToken } from '../lib/supabaseClient';
import { GeminiApiError, createFileStore, sanitizeStoreId } from '../lib/gemini';

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === 'GET') {
      await handleGet(req, res);
      return;
    }

    if (req.method === 'POST') {
      await handlePost(req, res);
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method Not Allowed', status: 405 });
  } catch (error: any) {
    console.error('Error in /api/file-stores:', error);
    if (handleKnownError(res, error)) {
      return;
    }
    res.status(500).json({ error: error?.message || 'Internal Server Error', status: 500 });
  }
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const token = getSupabaseBearerToken(req);
  if (!token) {
    res.status(401).json({ error: '認証が必要です。', status: 401 });
    return;
  }

  const supabase = getSupabaseClientWithToken(token);
  const admin = getSupabaseAdmin();
  const staff = await resolveStaffForRequest(admin, req);
  if (!staff) {
    res.status(403).json({ error: 'スタッフ情報が見つかりません。', status: 403 });
    return;
  }

  const { data, error } = await supabase
    .from('file_stores')
    .select('id, organization_id, office_id, gemini_store_name, display_name, description, created_by, created_at')
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
      .select('file_store_id, size_bytes');
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
    res.status(401).json({ error: '認証が必要です。', status: 401 });
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
    res.status(400).json({ error: 'JSON 形式で送信してください。', status: 400 });
    return;
  }
  const staff = await resolveStaffForRequest(admin, req);

  if (!staff?.officeId) {
    res.status(403).json({ error: '事業所に紐づいたスタッフ情報が見つかりません。', status: 403 });
    return;
  }

  const displayName = String(body.displayName || '').trim();
  if (!displayName) {
    res.status(400).json({ error: 'displayName は必須です。', status: 400 });
    return;
  }

  const description = typeof body.description === 'string' ? body.description : null;

  const requestedStoreId =
    typeof body.geminiStoreId === 'string' && body.geminiStoreId.trim()
      ? sanitizeStoreId(body.geminiStoreId.trim(), displayName)
      : sanitizeStoreId(displayName);

  const store = await createFileStore(requestedStoreId, displayName);

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
      res.status(409).json({ error: '同じストアがすでに存在します。', status: 409 });
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
      error: error.message,
      status,
      debugId: error.debugId ?? null,
    });
    return true;
  }
  return false;
}
