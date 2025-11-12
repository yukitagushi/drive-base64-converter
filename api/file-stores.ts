import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { buildSessionPayload, resolveStaffForRequest } from '../lib/api-auth';

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
    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error: any) {
    console.error('Error in /api/file-stores:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  const staff = await resolveStaffForRequest(admin, req);
  const queryParams = req.query as Record<string, string | string[] | undefined>;
  const officeId = firstValue(queryParams.officeId) || staff?.officeId || null;
  const organizationId = firstValue(queryParams.organizationId) || staff?.organizationId || null;
  const createdBy = firstValue(queryParams.createdBy);

  let query = admin.from('file_stores').select('*').order('created_at', { ascending: false });

  if (officeId) {
    query = query.eq('office_id', officeId);
  }

  if (organizationId) {
    query = query.eq('organization_id', organizationId);
  }

  if (createdBy) {
    query = query.eq('created_by', createdBy);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  let sessionPayload = null;
  if (staff) {
    sessionPayload = await buildSessionPayload(admin, staff).catch((err: any) => {
      console.error('file-stores session build error:', err?.message || err);
      return null;
    });
  }

  res.status(200).json({
    items: data ?? [],
    session: sessionPayload?.session,
    threads: sessionPayload?.threads,
  });
}

async function handlePost(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  let body: any = {};
  try {
    if (typeof req.body === 'string') {
      body = req.body ? JSON.parse(req.body) : {};
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }
  } catch (error: any) {
    res.status(400).json({ error: 'JSON 形式で送信してください。' });
    return;
  }
  const staff = await resolveStaffForRequest(admin, req);

  const officeId = body.officeId || staff?.officeId;
  const displayName = body.displayName;
  const description = body.description ?? null;
  const organizationId = body.organizationId ?? staff?.organizationId ?? null;
  const createdBy = body.createdBy ?? staff?.id ?? null;

  if (!officeId || !displayName) {
    res.status(400).json({ error: 'officeId と displayName は必須です。' });
    return;
  }

  const geminiStoreName: string = body.geminiStoreName || `store_${randomUUID()}`;

  const insertPayload = {
    office_id: officeId,
    organization_id: organizationId,
    gemini_store_name: geminiStoreName,
    display_name: displayName,
    description,
    created_by: createdBy,
  };

  const { data, error } = await admin.from('file_stores').insert(insertPayload).select('*').single();

  if (error) {
    throw new Error(error.message);
  }

  res.status(201).json({ item: data });
}
