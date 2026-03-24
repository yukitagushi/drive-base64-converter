import type { VercelRequest, VercelResponse } from '@vercel/node';
import { uploadFileToStore } from '../lib/gemini';
import {
  downloadOriginalFile,
  fetchStoreRow,
  FileRow,
  SupabaseActionError,
} from '../lib/geminiMediaSummary';
import { getSupabaseBearerToken, resolveStaffForRequest } from '../lib/api-auth';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';

const API_NAME = '/api/gemini-sync-documents';
const DOC_SYNC_LIMIT = 5;
const DOC_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

interface SyncResultEntry {
  fileId: string;
  status: 'success' | 'failed';
  action: 'doc_upload';
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

function respond(res: VercelResponse, status: number, payload: Record<string, any>) {
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

    if (!storeRow.gemini_store_name) {
      respond(res, 400, { error: 'Gemini File Search ストアが未設定です。' });
      return;
    }

    const candidates = await fetchPendingDocumentFiles(admin, fileStoreId, DOC_SYNC_LIMIT);
    const results: SyncResultEntry[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const file of candidates) {
      try {
        const buffer = await downloadOriginalFile(admin, file);
        const uploadResult = await uploadFileToStore({
          storeName: storeRow.gemini_store_name,
          fileBuffer: buffer,
          mimeType: file.mime_type || 'application/octet-stream',
          displayName: file.display_name,
          description: file.description || undefined,
        });

        const { error: updateError } = await admin
          .from('file_store_files')
          .update({ gemini_file_name: uploadResult.geminiFileName })
          .eq('id', file.id);

        if (updateError) {
          throw new SupabaseActionError('file_store_files', 'update', updateError);
        }

        results.push({
          fileId: file.id,
          status: 'success',
          action: 'doc_upload',
        });
        succeeded += 1;
      } catch (error: any) {
        failed += 1;
        const reason = classifyDocumentSyncError(error);
        console.error(`${API_NAME} failed to sync file ${file.id}`, {
          fileId: file.id,
          reason,
          error: error?.message || error,
        });
        results.push({
          fileId: file.id,
          status: 'failed',
          action: 'doc_upload',
          reason,
        });
      }
    }

    const pendingCount = await countPendingDocumentFiles(admin, fileStoreId);

    respond(res, 200, {
      success: true,
      processedCount: candidates.length,
      succeeded,
      failed,
      pendingCount,
      results,
    });
  } catch (error: any) {
    console.error(`${API_NAME} error`, error);
    const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
    respond(res, status, {
      error: 'document_sync_failed',
      message: error?.message || 'ドキュメント同期に失敗しました。',
    });
  }
}

async function fetchPendingDocumentFiles(admin: any, fileStoreId: string, limit: number): Promise<FileRow[]> {
  const { data, error } = await admin
    .from('file_store_files')
    .select(
      'id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, storage_bucket, storage_path, storage_object_path, uploaded_at',
    )
    .eq('file_store_id', fileStoreId)
    .or('gemini_file_name.is.null,gemini_file_name.eq.EMPTY,gemini_file_name.eq.')
    .in('mime_type', DOC_MIME_TYPES)
    .order('uploaded_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new SupabaseActionError('file_store_files', 'select', error);
  }

  return (data || []) as FileRow[];
}

async function countPendingDocumentFiles(admin: any, fileStoreId: string): Promise<number> {
  const { count, error } = await admin
    .from('file_store_files')
    .select('id', { count: 'exact', head: true })
    .eq('file_store_id', fileStoreId)
    .or('gemini_file_name.is.null,gemini_file_name.eq.EMPTY,gemini_file_name.eq.')
    .in('mime_type', DOC_MIME_TYPES);

  if (error) {
    throw new SupabaseActionError('file_store_files', 'count', error);
  }

  return count ?? 0;
}

function classifyDocumentSyncError(error: any): string {
  if (!error) {
    return 'unknown_error';
  }
  if (error instanceof SupabaseActionError) {
    if (error.operation === 'update') {
      return 'supabase_update_error';
    }
    return 'supabase_error';
  }
  const message = (error?.message || '').toLowerCase();
  if (message.includes('upload') || message.includes('gemini')) {
    return 'gemini_upload_error';
  }
  if (message.includes('download') || message.includes('buffer')) {
    return 'download_error';
  }
  return 'unknown_error';
}
