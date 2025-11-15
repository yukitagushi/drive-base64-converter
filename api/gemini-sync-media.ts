import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GeminiApiError } from '../lib/gemini';
import {
  ensureMediaSummaryForFile,
  FileRow,
  StoreRow,
  isMediaMime,
  serializeGeminiError,
  serializeSupabaseError,
  SupabaseActionError,
} from '../lib/geminiMediaSummary';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { getSupabaseBearerToken, resolveStaffForRequest } from '../lib/api-auth';
import { getSupabaseClientWithToken } from '../lib/supabaseClient';

const API_NAME = '/api/gemini-sync-media';
const SYNC_LIMIT = 10;

interface SyncCandidate extends FileRow {
  file_stores: StoreRow | null;
}

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

  try {
    const candidates = await fetchSyncCandidates(admin, staff.officeId, SYNC_LIMIT);
    const processedFileIds: string[] = candidates.map((candidate) => candidate.id);
    let succeeded = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        if (!candidate.file_stores) {
          throw new Error('ファイルストア情報が見つかりません。');
        }

        if (!isMediaMime(candidate.mime_type)) {
          throw new Error('画像または動画ファイルのみ処理できます。');
        }

        const result = await ensureMediaSummaryForFile({
          admin,
          supabase,
          fileRow: candidate,
          storeRow: candidate.file_stores,
          staffId: staff.id,
        });

        if (result.status === 'created' || result.status === 'already-exists') {
          succeeded += 1;
        }
      } catch (error: any) {
        failed += 1;
        console.error(`${API_NAME} failed to process file ${candidate.id}`, {
          fileId: candidate.id,
          message: error?.message || String(error),
          geminiError: serializeGeminiError(error instanceof GeminiApiError ? error : null),
          supabaseError: error instanceof SupabaseActionError ? serializeSupabaseError(error) : null,
        });
      }
    }

    respond(res, 200, {
      success: true,
      processedCount: processedFileIds.length,
      succeeded,
      failed,
      processedFileIds,
    });
  } catch (error: any) {
    const status = error instanceof GeminiApiError ? error.status ?? 500 : 500;
    console.error(`${API_NAME} error:`, error);
    respond(res, status, {
      error: 'sync_media_failed',
      message: error?.message || 'メディア解析テキストの同期に失敗しました。',
      geminiError: serializeGeminiError(error instanceof GeminiApiError ? error : null),
      supabaseError: error instanceof SupabaseActionError ? serializeSupabaseError(error) : null,
    });
  }
}

async function fetchSyncCandidates(admin: any, officeId: string, limit: number): Promise<SyncCandidate[]> {
  const { data, error } = await admin
    .from('file_store_files')
    .select(
      `id,
       file_store_id,
       gemini_file_name,
       display_name,
       description,
       size_bytes,
       mime_type,
       uploaded_at,
       storage_bucket,
       storage_path,
       storage_object_path,
       file_stores!inner (
         id,
         gemini_store_name,
         office_id
       )`,
    )
    .or('gemini_file_name.is.null,gemini_file_name.eq.,gemini_file_name.eq.EMPTY')
    .or('mime_type.ilike.image/%,mime_type.ilike.video/%')
    .eq('file_stores.office_id', officeId)
    .order('uploaded_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new SupabaseActionError('file_store_files', 'select', error);
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((row: any) => ({
    ...(row as FileRow),
    file_stores: row.file_stores as StoreRow | null,
  }));
}
