import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  ensureImageSummaryForFile,
  fetchFileRow,
  fetchStoreRow,
  isImageMime,
  serializeGeminiError,
  serializeSupabaseError,
  SupabaseActionError,
} from '../lib/geminiImageSummary';
import { GeminiApiError } from '../lib/gemini';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { getSupabaseBearerToken, resolveStaffForRequest } from '../lib/api-auth';
import { getSupabaseClientWithToken } from '../lib/supabaseClient';

const API_NAME = '/api/gemini-register-image-summary';

function applyCors(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string | undefined) || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
}

function respond(
  res: VercelResponse,
  status: number,
  payload: Record<string, any>,
  debug: Record<string, any> | null = null,
) {
  if (debug && Object.keys(debug).length > 0) {
    res.status(status).json({ source: 'api', status, ...payload, debug });
    return;
  }
  res.status(status).json({ source: 'api', status, ...payload });
}

async function readJsonBody(req: VercelRequest): Promise<Record<string, any>> {
  if ((req as any).body) {
    const body = (req as any).body;
    if (typeof body === 'object') {
      return body;
    }
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new Error('JSON の解析に失敗しました。');
      }
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('JSON の解析に失敗しました。');
  }
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

  const token = getSupabaseBearerToken(req);
  if (!token) {
    respond(res, 401, { error: '認証が必要です。' });
    return;
  }

  const admin = getSupabaseAdmin();
  const supabase = getSupabaseClientWithToken(token);
  const staff = await resolveStaffForRequest(admin, req);

  if (!staff) {
    respond(res, 403, { error: 'スタッフ情報が見つかりません。' });
    return;
  }

  if (!staff.officeId) {
    respond(res, 403, { error: '事業所情報が見つかりません。' });
    return;
  }

  let body: Record<string, any>;
  try {
    body = await readJsonBody(req);
  } catch (error: any) {
    respond(res, 400, { error: error?.message || 'JSON の解析に失敗しました。' });
    return;
  }

  const fileIdRaw = body.fileId ?? body.id;
  const fileId = fileIdRaw ? String(fileIdRaw).trim() : '';
  if (!fileId) {
    respond(res, 400, { error: 'fileId を指定してください。' });
    return;
  }

  try {
    const fileRow = await fetchFileRow(admin, fileId);
    if (!fileRow) {
      respond(res, 404, { error: '指定したファイルが見つかりません。' });
      return;
    }

    const storeRow = await fetchStoreRow(admin, fileRow.file_store_id);
    if (!storeRow) {
      respond(res, 404, { error: 'ファイルストアが見つかりません。' });
      return;
    }

    if (storeRow.office_id && storeRow.office_id !== staff.officeId) {
      respond(res, 403, { error: 'このファイルにはアクセスできません。' });
      return;
    }

    if (!isImageMime(fileRow.mime_type)) {
      respond(res, 400, { error: '画像ファイルのみ処理できます。' });
      return;
    }

    const result = await ensureImageSummaryForFile({
      admin,
      supabase,
      fileRow,
      storeRow,
      staffId: staff.id,
    });

    if (result.status === 'already-exists') {
      respond(res, 200, {
        success: true,
        alreadyProcessed: true,
        fileId: fileRow.id,
        summaryFile: result.summaryFile,
      });
      return;
    }

    respond(res, 200, {
      success: true,
      fileId: fileRow.id,
      summaryFile: result.summaryFile,
    });
  } catch (error: any) {
    const status = error instanceof GeminiApiError ? error.status ?? 500 : 500;
    console.error(`${API_NAME} error:`, error);
    respond(res, status, {
      error: 'register_image_summary_failed',
      message: error?.message || '画像解析テキストの登録に失敗しました。',
      geminiError: serializeGeminiError(error instanceof GeminiApiError ? error : null),
      supabaseError: error instanceof SupabaseActionError ? serializeSupabaseError(error) : null,
    });
  }
}
