import type { VercelRequest, VercelResponse } from '@vercel/node';

import { getSupabaseBearerToken, resolveStaffForRequest } from '../../lib/api-auth';
import { ensureStorageBucket } from '../../lib/storage';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';

const DEFAULT_BUCKET = 'gemini-upload-cache';
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

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

    const bodyText = (await readBody(req)) || '{}';
    let payload: { bucket?: string } = {};
    try {
      payload = JSON.parse(bodyText);
    } catch (error: any) {
      respond(res, 400, { error: 'JSON の解析に失敗しました。' });
      return;
    }

    const bucket = (payload.bucket || DEFAULT_BUCKET).trim();
    if (!bucket) {
      respond(res, 400, { error: 'bucket を指定してください。' });
      return;
    }

    await ensureStorageBucket({ bucket, admin, sizeLimitBytes: MAX_UPLOAD_BYTES });

    respond(res, 200, { ok: true, bucket });
  } catch (error: any) {
    console.error('Error in /api/storage/ensure-bucket:', error?.message || error);
    respond(res, 500, { error: error?.message || 'バケットの確認に失敗しました。' });
  }
}

async function readBody(req: VercelRequest): Promise<string> {
  const existing = (req as any).body;
  if (existing && typeof existing === 'string') {
    return existing;
  }
  if (existing && typeof existing === 'object') {
    return JSON.stringify(existing);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
