import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GeminiApiError } from '../lib/gemini';
import {
  ensureAudioTranscriptForFile,
  ensureImageSummaryForFile,
  ensureVideoSummaryForFile,
  fetchStoreRow,
  FileRow,
  isAudioMime,
  isImageMime,
  isVideoMime,
  markOriginalFileAsProcessed,
  serializeGeminiError,
  serializeSupabaseError,
  SupabaseActionError,
} from '../lib/geminiMediaSummary';
import { OpenAITranscriptionError, serializeOpenAIError } from '../lib/openaiAudio';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { getSupabaseBearerToken, resolveStaffForRequest } from '../lib/api-auth';
import { getSupabaseClientWithToken } from '../lib/supabaseClient';

const API_NAME = '/api/gemini-sync-media';
const SYNC_PROCESS_LIMIT = 3;
const SYNC_FETCH_LIMIT = 12;
const MIN_IMAGE_SIZE_BYTES = 1024;
const MACOS_METADATA_PREFIX = '__MACOSX';
const SKIPPED_MACOS_METADATA = 'SKIPPED_MACOS_METADATA';
const SKIPPED_TOO_SMALL_IMAGE = 'SKIPPED_TOO_SMALL_IMAGE';

const GEMINI_PENDING_MATCHERS = ['gemini_file_name.is.null', 'gemini_file_name.eq.', 'gemini_file_name.eq.EMPTY'];
const MIME_PENDING_MATCHERS = ['mime_type.ilike.image/%', 'mime_type.ilike.video/%', 'mime_type.ilike.audio/%'];
const PENDING_MEDIA_FILTER = buildPendingMediaCondition(MIN_IMAGE_SIZE_BYTES);

interface SyncResultEntry {
  fileId: string;
  status: 'success' | 'failed' | 'skipped';
  action: 'image_summary' | 'video_transcript' | 'audio_transcript' | 'skipped';
  summaryFile?: { id: string; displayName: string; geminiFileName: string | null } | null;
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

    const candidates = await fetchPendingMediaFiles(admin, fileStoreId, SYNC_FETCH_LIMIT);
    const queue = candidates.slice(0, SYNC_PROCESS_LIMIT);

    const results: SyncResultEntry[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const candidate of queue) {
      const mimeType = (candidate.mime_type || '').toLowerCase();
      const isImage = isImageMime(mimeType);
      const isAudio = isAudioMime(mimeType);
      const isVideo = isVideoMime(mimeType);
      let action: SyncResultEntry['action'] =
        (isAudio && 'audio_transcript') ||
        (isVideo && 'video_transcript') ||
        (isImage && 'image_summary') ||
        'skipped';

      const displayName = candidate.display_name || '';
      if (displayName.startsWith(MACOS_METADATA_PREFIX)) {
        try {
          await markOriginalFileAsProcessed(admin, candidate.id, SKIPPED_MACOS_METADATA);
          results.push({
            fileId: candidate.id,
            status: 'skipped',
            action,
            reason: 'macos_metadata',
          });
        } catch (error: any) {
          failed += 1;
          const reason = classifySyncError(error);
          console.error(`${API_NAME} failed to mark macOS metadata file as skipped`, {
            fileId: candidate.id,
            reason,
            error: error?.message || error,
          });
          results.push({
            fileId: candidate.id,
            status: 'failed',
            action,
            reason,
          });
        }
        continue;
      }

      if (isImage && candidate.size_bytes != null && candidate.size_bytes < MIN_IMAGE_SIZE_BYTES) {
        try {
          await markOriginalFileAsProcessed(admin, candidate.id, SKIPPED_TOO_SMALL_IMAGE);
          results.push({
            fileId: candidate.id,
            status: 'skipped',
            action,
            reason: 'too_small_image',
          });
        } catch (error: any) {
          failed += 1;
          const reason = classifySyncError(error);
          console.error(`${API_NAME} failed to mark tiny image as skipped`, {
            fileId: candidate.id,
            reason,
            error: error?.message || error,
          });
          results.push({
            fileId: candidate.id,
            status: 'failed',
            action,
            reason,
          });
        }
        continue;
      }

      try {
        if (isAudio) {
          action = 'audio_transcript';
          const transcriptResult = await ensureAudioTranscriptForFile({
            admin,
            supabase,
            fileRow: candidate,
            storeRow,
            staffId: staff.id,
          });
          results.push({
            fileId: candidate.id,
            status: 'success',
            action,
            summaryFile: transcriptResult.summaryFile,
          });
          succeeded += 1;
        } else if (isVideo) {
          action = 'video_transcript';
          const videoResult = await ensureVideoSummaryForFile({
            admin,
            supabase,
            fileRow: candidate,
            storeRow,
            staffId: staff.id,
          });
          results.push({
            fileId: candidate.id,
            status: 'success',
            action,
            summaryFile: videoResult.summaryFile,
          });
          succeeded += 1;
        } else if (isImage) {
          action = 'image_summary';
          const imageResult = await ensureImageSummaryForFile({
            admin,
            supabase,
            fileRow: candidate,
            storeRow,
            staffId: staff.id,
          });
          results.push({
            fileId: candidate.id,
            status: 'success',
            action,
            summaryFile: imageResult.summaryFile,
          });
          succeeded += 1;
        } else {
          results.push({
            fileId: candidate.id,
            status: 'failed',
            action,
            reason: 'unsupported_mime',
          });
          failed += 1;
        }
      } catch (error: any) {
        failed += 1;
        const reason = classifySyncError(error);
        console.error(`${API_NAME} failed to process file ${candidate.id}`, {
          fileId: candidate.id,
          message: error?.message || String(error),
          geminiError: serializeGeminiError(error),
          openaiError: serializeOpenAIError(error),
          supabaseError: error instanceof SupabaseActionError ? serializeSupabaseError(error) : null,
          reason,
        });
        results.push({
          fileId: candidate.id,
          status: 'failed',
          action,
          reason,
        });
      }
    }

    const pendingCount = await countPendingMediaFiles(admin, fileStoreId);

    respond(res, 200, {
      success: true,
      processedCount: queue.length,
      succeeded,
      failed,
      pendingCount,
      results,
    });
  } catch (error: any) {
    const status = error instanceof GeminiApiError ? error.status ?? 500 : 500;
    console.error(`${API_NAME} error:`, error);
    respond(res, status, {
      error: 'sync_media_failed',
      message: error?.message || 'メディア自動同期に失敗しました。',
      geminiError: serializeGeminiError(error instanceof GeminiApiError ? error : null),
      supabaseError: error instanceof SupabaseActionError ? serializeSupabaseError(error) : null,
    });
  }
}

async function fetchPendingMediaFiles(admin: any, fileStoreId: string, limit: number): Promise<FileRow[]> {
  const { data, error } = await admin
    .from('file_store_files')
    .select(
      'id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, uploaded_at, storage_bucket, storage_path, storage_object_path',
    )
    .eq('file_store_id', fileStoreId)
    .or(PENDING_MEDIA_FILTER)
    .not('display_name', 'ilike', `${MACOS_METADATA_PREFIX}%`)
    .order('uploaded_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) {
    throw new SupabaseActionError('file_store_files', 'select', error);
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return data as FileRow[];
}

async function countPendingMediaFiles(admin: any, fileStoreId: string): Promise<number> {
  const { count, error } = await admin
    .from('file_store_files')
    .select('id', { count: 'exact', head: true })
    .eq('file_store_id', fileStoreId)
    .or(PENDING_MEDIA_FILTER)
    .not('display_name', 'ilike', `${MACOS_METADATA_PREFIX}%`);

  if (error) {
    throw new SupabaseActionError('file_store_files', 'count', error);
  }

  return count ?? 0;
}

function buildPendingMediaCondition(minImageSizeBytes: number): string {
  const combos: string[] = [];
  for (const geminiMatcher of GEMINI_PENDING_MATCHERS) {
    for (const mimeMatcher of MIME_PENDING_MATCHERS) {
      const clauses = [geminiMatcher, mimeMatcher];
      if (mimeMatcher.includes('image/%')) {
        clauses.push(`size_bytes.gt.${minImageSizeBytes}`);
      }
      combos.push(`and(${clauses.join(',')})`);
    }
  }
  return combos.join(',');
}

function classifySyncError(error: unknown): string {
  if (error instanceof OpenAITranscriptionError) {
    const message = String(error.message || '').toLowerCase();
    if (message.includes('maximum content size limit')) {
      return 'openai_size_limit';
    }
    return 'openai_transcription_error';
  }
  if (error instanceof GeminiApiError) {
    return 'gemini_error';
  }
  if (error instanceof SupabaseActionError) {
    return 'supabase_error';
  }
  return 'unknown_error';
}
