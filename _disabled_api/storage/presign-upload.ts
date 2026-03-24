import type { VercelRequest, VercelResponse } from '@vercel/node';

import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { createSignedUploadUrl, ensureStorageBucket } from '../../lib/storage';
import { getSupabaseBearerToken, resolveStaffForRequest } from '../../lib/api-auth';

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

    let body: any = {};
    if (typeof req.body === 'string') {
      try {
        body = req.body ? JSON.parse(req.body) : {};
      } catch (error) {
        respond(res, 400, { error: 'JSON 形式で送信してください。' });
        return;
      }
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    const bucket = typeof body.bucket === 'string' && body.bucket.trim() ? body.bucket.trim() : 'gemini-upload-cache';
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    const expiresInSeconds = Number.isFinite(body.expiresInSeconds) ? Number(body.expiresInSeconds) : 300;

    if (!path) {
      respond(res, 400, { error: 'path は必須です。' });
      return;
    }

    await ensureStorageBucket({ bucket, admin });

    const signed = await createSignedUploadUrl({ bucket, path, admin, expiresInSeconds });

    respond(res, 200, {
      bucket: signed.bucket,
      path: signed.path,
      token: signed.token,
      signedUrl: signed.signedUrl,
      expiresAt: signed.expiresAt,
      expiresInSeconds,
    });
  } catch (error: any) {
    console.error('Error in /api/storage/presign-upload:', error);
    respond(res, 500, { error: error?.message || '署名付き URL の生成に失敗しました。' });
  }
}
