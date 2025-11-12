import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { resolveStaffForRequest } from '../lib/api-auth';

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
    console.error('Error in /api/documents:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  const query = req.query as Record<string, string | string[] | undefined>;
  const fileStoreId = firstValue(query.fileStoreId);

  if (!fileStoreId) {
    res.status(400).json({ error: 'fileStoreId は必須です。' });
    return;
  }

  const { data, error } = await admin
    .from('file_store_files')
    .select('*')
    .eq('file_store_id', fileStoreId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  res.status(200).json({ items: data ?? [] });
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

  const fileStoreId = body.fileStoreId;
  const geminiFileName = body.geminiFileName;
  const displayName = body.displayName;
  const sizeBytes = body.sizeBytes ?? null;
  const mimeType = body.mimeType ?? null;
  const description = body.description ?? null;
  const uploadedBy = body.uploadedBy ?? staff?.id ?? null;

  if (!fileStoreId || !geminiFileName || !displayName) {
    res.status(400).json({ error: 'fileStoreId, geminiFileName, displayName は必須です。' });
    return;
  }

  const insertPayload = {
    file_store_id: fileStoreId,
    gemini_file_name: geminiFileName,
    display_name: displayName,
    size_bytes: typeof sizeBytes === 'number' ? sizeBytes : sizeBytes ? Number(sizeBytes) : null,
    mime_type: mimeType,
    description,
    uploaded_by: uploadedBy,
  };

  const { data, error } = await admin.from('file_store_files').insert(insertPayload).select('*').single();

  if (error) {
    throw new Error(error.message);
  }

  res.status(201).json({ item: data });
}
