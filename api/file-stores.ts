import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export default async function handler(req: any, res: any) {
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

async function handleGet(req: any, res: any) {
  const admin = getSupabaseAdmin();
  const officeId = firstValue(req.query?.officeId);
  const organizationId = firstValue(req.query?.organizationId);
  const createdBy = firstValue(req.query?.createdBy);

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

  res.status(200).json({ items: data ?? [] });
}

async function handlePost(req: any, res: any) {
  const admin = getSupabaseAdmin();
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  const officeId = body.officeId;
  const displayName = body.displayName;
  const description = body.description ?? null;
  const organizationId = body.organizationId ?? null;
  const createdBy = body.createdBy ?? null;

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
