import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GeminiApiError } from '../lib/gemini';
import {
  EnsureDocumentUploadResult,
  EnsureMediaSummaryResult,
  FileRow,
  ensureDocumentUploadedForFile,
  ensureMediaSummaryForFile,
  fetchStoreRow,
  isDocumentMime,
  isMediaMime,
  serializeGeminiError,
  serializeSupabaseError,
  SupabaseActionError,
} from '../lib/geminiMediaSummary';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { getSupabaseBearerToken, resolveStaffForRequest } from '../lib/api-auth';
import { getSupabaseClientWithToken } from '../lib/supabaseClient';

const API_NAME = '/api/gemini-sync-pending';
const SYNC_LIMIT = 5;

interface SyncResult {
  fileId: string;
  action: 'media-summary' | 'document-upload' | 'skipped';
  status: 'success' | 'already' | 'skipped';
  summaryFile?: EnsureMediaSummaryResult['summaryFile'];
  geminiFileName?: string | null;
  reason?: string;
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

  const fileStoreIdRaw = body.fileStoreId ?? body.file_store_id;
  const fileStoreId = fileStoreIdRaw ? String(fileStoreIdRaw).trim() : '';
  if (!fileStoreId) {
    respond(res, 400, { error: 'fileStoreId を指定してください。' });
    return;
  }

  try {
    const storeRow = await fetchStoreRow(admin, fileStoreId);
    if (!storeRow) {
      respond(res, 404, { error: 'ファイルストアが見つかりません。' });
      return;
    }

    if (storeRow.office_id && storeRow.office_id !== staff.officeId) {
      respond(res, 403, { error: 'このストアにはアクセスできません。' });
      return;
    }

    const candidates = await fetchPendingFiles(admin, fileStoreId, SYNC_LIMIT);
    const processedFileIds = candidates.map((candidate) => candidate.id);
    let succeeded = 0;
    let failed = 0;
    const results: SyncResult[] = [];

    for (const candidate of candidates) {
      try {
        if (isMediaMime(candidate.mime_type)) {
          const mediaResult = await ensureMediaSummaryForFile({
            admin,
            supabase,
            fileRow: candidate,
            storeRow,
            staffId: staff.id,
          });
          results.push({
            fileId: candidate.id,
            action: 'media-summary',
            status: mediaResult.status === 'already-exists' ? 'already' : 'success',
            summaryFile: mediaResult.summaryFile,
          });
          succeeded += 1;
          continue;
        }

        if (isDocumentMime(candidate.mime_type)) {
          const docResult: EnsureDocumentUploadResult = await ensureDocumentUploadedForFile({
            admin,
            fileRow: candidate,
            storeRow,
          });
          results.push({
            fileId: candidate.id,
            action: 'document-upload',
            status: docResult.status === 'already-registered' ? 'already' : 'success',
            geminiFileName: docResult.geminiFileName,
          });
          succeeded += 1;
          continue;
        }

        console.warn(`${API_NAME} skipping unsupported mime`, {
          fileId: candidate.id,
          mimeType: candidate.mime_type,
        });
        results.push({
          fileId: candidate.id,
          action: 'skipped',
          status: 'skipped',
          reason: 'unsupported_mime',
        });
      } catch (error: any) {
        failed += 1;
        console.error(`${API_NAME} failed to process file ${candidate.id}`, {
          fileId: candidate.id,
          message: error?.message || String(error),
          geminiError: serializeGeminiError(error),
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
      results,
    });
  } catch (error: any) {
    const status = error instanceof GeminiApiError ? error.status ?? 500 : 500;
    console.error(`${API_NAME} error:`, error);
    respond(res, status, {
      error: 'sync_pending_failed',
      message: error?.message || '未登録ファイルの同期に失敗しました。',
      geminiError: serializeGeminiError(error instanceof GeminiApiError ? error : null),
      supabaseError: error instanceof SupabaseActionError ? serializeSupabaseError(error) : null,
    });
  }
}

async function fetchPendingFiles(admin: any, fileStoreId: string, limit: number): Promise<FileRow[]> {
  const { data, error } = await admin
    .from('file_store_files')
    .select(
      'id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, uploaded_at, storage_bucket, storage_path, storage_object_path',
    )
    .eq('file_store_id', fileStoreId)
    .or('gemini_file_name.is.null,gemini_file_name.eq.,gemini_file_name.eq.EMPTY')
    .order('uploaded_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new SupabaseActionError('file_store_files', 'select', error);
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return data as FileRow[];
}
