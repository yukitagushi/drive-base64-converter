import { extname } from 'node:path';
import {
  analyzeInlineMediaWithGemini,
  uploadFileToStore,
  GeminiApiError,
} from './gemini';
import { transcribeWithOpenAI } from './openaiAudio';

export const SUMMARY_DESCRIPTION = 'Gemini によるメディア解析テキストです。';
export const SUMMARY_MIME_TYPE = 'text/plain';
export const AUDIO_TRANSCRIPT_DESCRIPTION = 'OpenAI による音声文字起こしテキストです。';
export const VIDEO_TRANSCRIPT_DESCRIPTION = 'OpenAI による動画音声の文字起こしテキストです。';
const TRANSCRIPT_SUFFIX = '-transcript.txt';
const AUDIO_TRANSCRIPT_HEADING = '# OpenAI 音声文字起こし';
const VIDEO_TRANSCRIPT_HEADING = '# OpenAI 動画音声文字起こし';
const DEFAULT_TRANSCRIPT_LANGUAGE = process.env.OPENAI_TRANSCRIPT_LANGUAGE || 'ja';
const DEFAULT_STORAGE_BUCKET_CANDIDATES = ['file-store-files', 'gemini-upload-cache'];
const UNREGISTERED_SENTINELS = new Set(['', 'EMPTY']);
const DOCUMENT_MIME_PREFIXES = ['text/'];
const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/json',
  'application/csv',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface FileRow {
  id: string;
  file_store_id: string;
  gemini_file_name: string | null;
  display_name: string;
  description: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  storage_object_path?: string | null;
  uploaded_at?: string | null;
}

export interface StoreRow {
  id: string;
  gemini_store_name: string;
  office_id: string | null;
}

export interface SummaryRecord {
  id: string;
  displayName: string;
  geminiFileName: string | null;
}

export interface EnsureMediaSummaryResult {
  status: 'already-exists' | 'created';
  summaryName: string;
  summaryFile: SummaryRecord;
}

export interface EnsureAudioTranscriptResult extends EnsureMediaSummaryResult {}

interface TranscriptOptions {
  description: string;
  heading: string;
  defaultBaseName: string;
  fallbackMime: string;
  language?: string;
  summarySuffix?: string;
}

export class SupabaseActionError extends Error {
  table: string;
  operation: string;
  supabaseError: any;

  constructor(table: string, operation: string, supabaseError: any) {
    super(supabaseError?.message || `Supabase ${operation} failed for ${table}`);
    this.name = 'SupabaseActionError';
    this.table = table;
    this.operation = operation;
    this.supabaseError = supabaseError ?? null;
  }
}

export function serializeGeminiError(error: unknown): Record<string, any> | null {
  if (!error) {
    return null;
  }
  if (error instanceof GeminiApiError) {
    return {
      name: error.name,
      status: error.status ?? null,
      message: error.message,
      debugId: error.debugId ?? null,
      body: error.body ?? null,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { error: String(error) };
}

export function serializeSupabaseError(error: SupabaseActionError | null): Record<string, any> | null {
  if (!error) {
    return null;
  }

  const raw = error.supabaseError || {};
  const payload =
    raw && typeof raw === 'object'
      ? {
          message: raw.message ?? null,
          details: raw.details ?? null,
          hint: raw.hint ?? null,
          code: raw.code ?? null,
        }
      : { message: raw ? String(raw) : null };

  return {
    table: error.table,
    operation: error.operation,
    ...payload,
  };
}

function normalizeMime(value: string | null | undefined): string {
  return (value || '').split(';')[0]?.trim().toLowerCase() || '';
}

export function isImageMime(mimeType: string | null | undefined): boolean {
  return normalizeMime(mimeType).startsWith('image/');
}

export function isVideoMime(mimeType: string | null | undefined): boolean {
  return normalizeMime(mimeType).startsWith('video/');
}

export function isAudioMime(mimeType: string | null | undefined): boolean {
  return normalizeMime(mimeType).startsWith('audio/');
}

export function isMediaMime(mimeType: string | null | undefined): boolean {
  return isImageMime(mimeType) || isVideoMime(mimeType);
}

export function isDocumentMime(mimeType: string | null | undefined): boolean {
  const normalized = normalizeMime(mimeType);
  if (!normalized) {
    return false;
  }
  if (DOCUMENT_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  return DOCUMENT_MIME_TYPES.has(normalized);
}

function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) {
    return filename;
  }
  return filename.slice(0, idx);
}

function createMediaAnalysisSummary(originalName: string, analysis: any): string {
  const lines: string[] = [];
  lines.push('# Gemini メディア解析レポート');
  lines.push(`対象ファイル: ${originalName}`);
  if (analysis?.model) {
    lines.push(`モデル: ${analysis.model}`);
  }

  if (analysis?.text) {
    lines.push('', String(analysis.text).trim());
  }

  const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
  if (candidates.length > 1) {
    lines.push('', '---', '追加候補:');
    candidates.forEach((candidate: any, index: number) => {
      const detail: string[] = [`## 候補 ${index + 1}`];
      if (candidate?.text) {
        detail.push(String(candidate.text).trim());
      }
      if (candidate?.finishReason) {
        detail.push(`(finishReason: ${candidate.finishReason})`);
      }
      lines.push('', detail.join('\n'));
    });
  }

  if (analysis?.usage) {
    try {
      lines.push('', '---', 'トークン使用量:', JSON.stringify(analysis.usage, null, 2));
    } catch (error) {
      console.warn('geminiMediaSummary failed to stringify usage payload', error);
    }
  }

  return lines.join('\n');
}

function createTranscriptDocument(options: {
  heading: string;
  originalName: string;
  transcript: string;
}): string {
  const heading = options.heading || '# OpenAI 文字起こし';
  const lines: string[] = [];
  lines.push(heading);
  lines.push(`対象ファイル: ${options.originalName}`);

  const cleaned = options.transcript?.trim() || '';
  if (cleaned) {
    lines.push('', cleaned);
  } else {
    lines.push('', '（文字起こし結果を取得できませんでした）');
  }

  return lines.join('\n');
}

async function bufferFromUnknown(data: any): Promise<Buffer> {
  if (!data) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  if (typeof data.arrayBuffer === 'function') {
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  if (typeof data.text === 'function') {
    const text = await data.text();
    return Buffer.from(text, 'utf8');
  }
  throw new Error('Unknown buffer type');
}

function buildStoragePathCandidates(file: FileRow): string[] {
  const safeName = file.display_name || 'file';
  const extension = extname(safeName);
  const fallbackName = extension ? safeName : `${safeName}.bin`;
  const safeId = file.id || 'unknown';
  const storeId = file.file_store_id || 'store';
  const baseCandidates = [
    file.storage_object_path,
    file.storage_path,
    `${storeId}/${safeId}/${safeName}`,
    `${storeId}/${safeId}`,
    `${storeId}/${safeName}`,
    `${safeId}/${safeName}`,
    `${safeId}`,
    `${safeId}${extension || ''}`,
    safeName,
    fallbackName,
  ];

  const unique = new Set<string>();
  for (const entry of baseCandidates) {
    const trimmed = typeof entry === 'string' ? entry.trim().replace(/^\.+|^\/+|\/+$|^\\+/g, '') : '';
    if (trimmed) {
      unique.add(trimmed);
    }
  }

  return Array.from(unique);
}

export async function downloadOriginalFile(admin: any, file: FileRow): Promise<Buffer> {
  const directBucket = (file.storage_bucket || '').trim();
  const directPath = (file.storage_path || '').trim();
  const primaryBucket = directBucket || DEFAULT_STORAGE_BUCKET_CANDIDATES[0];

  if (directPath) {
    try {
      const directResponse = await admin.storage.from(primaryBucket).download(directPath);
      if (!directResponse.error && directResponse.data) {
        const directBuffer = await bufferFromUnknown(directResponse.data);
        if (directBuffer.length) {
          return directBuffer;
        }
        console.warn('downloadOriginalFile: direct download returned empty buffer', {
          bucket: primaryBucket,
          path: directPath,
        });
      } else if (directResponse.error) {
        console.warn('downloadOriginalFile: direct download error', {
          bucket: primaryBucket,
          path: directPath,
          error: directResponse.error?.message || null,
        });
      }
    } catch (error: any) {
      console.warn('downloadOriginalFile: direct download threw', {
        bucket: primaryBucket,
        path: directPath,
        error: error?.message || error,
      });
    }
  }

  const pathCandidates = buildStoragePathCandidates(file);
  const bucketCandidates = new Set<string>();

  if (directBucket) {
    bucketCandidates.add(directBucket);
  }
  DEFAULT_STORAGE_BUCKET_CANDIDATES.forEach((bucket) => bucketCandidates.add(bucket));

  for (const bucket of bucketCandidates) {
    for (const path of pathCandidates) {
      if (directPath && bucket === primaryBucket && path === directPath) {
        continue;
      }
      try {
        const response = await admin.storage.from(bucket).download(path);
        if (response.error) {
          continue;
        }
        const buffer = await bufferFromUnknown(response.data);
        if (buffer.length) {
          console.info('downloadOriginalFile: fallback candidate succeeded', { bucket, path });
          return buffer;
        }
      } catch (error: any) {
        console.warn('downloadOriginalFile: fallback download failed', {
          bucket,
          path,
          error: error?.message || error,
        });
        continue;
      }
    }
  }

  throw new Error('保存されたファイルを取得できませんでした。');
}

export function isUnregisteredGeminiName(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return true;
  }
  return UNREGISTERED_SENTINELS.has(normalized.toUpperCase());
}

export async function markOriginalFileAsProcessed(
  admin: any,
  fileId: string,
  newGeminiName: string | null | undefined,
): Promise<void> {
  const candidateValue = (newGeminiName ?? '').trim() || 'SUMMARY_GENERATED';
  const { error } = await admin
    .from('file_store_files')
    .update({ gemini_file_name: candidateValue })
    .eq('id', fileId)
    .or('gemini_file_name.is.null,gemini_file_name.eq.,gemini_file_name.eq.EMPTY');

  if (error) {
    throw new SupabaseActionError('file_store_files', 'update', error);
  }
}

export async function fetchFileRow(admin: any, fileId: string): Promise<FileRow | null> {
  const { data, error } = await admin
    .from('file_store_files')
    .select(
      'id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, storage_bucket, storage_path, storage_object_path, uploaded_at',
    )
    .eq('id', fileId)
    .maybeSingle();

  if (error) {
    throw new SupabaseActionError('file_store_files', 'select', error);
  }

  if (!data) {
    return null;
  }

  return data as FileRow;
}

export async function fetchStoreRow(admin: any, storeId: string): Promise<StoreRow | null> {
  const { data, error } = await admin
    .from('file_stores')
    .select('id, gemini_store_name, office_id')
    .eq('id', storeId)
    .maybeSingle();

  if (error) {
    throw new SupabaseActionError('file_stores', 'select', error);
  }

  if (!data) {
    return null;
  }

  return data as StoreRow;
}

async function findExistingSummary(admin: any, storeId: string, displayName: string): Promise<SummaryRecord | null> {
  const { data, error } = await admin
    .from('file_store_files')
    .select('id, display_name, gemini_file_name')
    .eq('file_store_id', storeId)
    .eq('display_name', displayName)
    .maybeSingle();

  if (error) {
    throw new SupabaseActionError('file_store_files', 'select', error);
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id,
    displayName: data.display_name,
    geminiFileName: data.gemini_file_name,
  };
}

async function insertSummaryRecord(
  admin: any,
  supabase: any,
  params: {
    fileStoreId: string;
    summaryName: string;
    summaryBuffer: Buffer;
    geminiFileName: string | null;
    staffId: string;
    description?: string | null;
    mimeType?: string | null;
  },
): Promise<SummaryRecord> {
  const insertPayload = {
    file_store_id: params.fileStoreId,
    gemini_file_name: params.geminiFileName,
    display_name: params.summaryName,
    description: params.description ?? SUMMARY_DESCRIPTION,
    size_bytes: params.summaryBuffer.length,
    mime_type: params.mimeType ?? SUMMARY_MIME_TYPE,
    uploaded_by: params.staffId,
  };

  const { data: inserted, error } = await admin
    .from('file_store_files')
    .insert(insertPayload)
    .select('id, display_name, gemini_file_name')
    .single();

  if (error) {
    throw new SupabaseActionError('file_store_files', 'insert', error);
  }

  if (supabase) {
    try {
      await supabase
        .from('file_store_files')
        .select('id')
        .eq('id', inserted.id)
        .maybeSingle();
    } catch (readerError) {
      console.warn('geminiMediaSummary failed to refresh user-facing view', readerError);
    }
  }

  return {
    id: inserted.id,
    displayName: inserted.display_name,
    geminiFileName: inserted.gemini_file_name,
  };
}

export async function ensureMediaSummaryForFile(params: {
  admin: any;
  supabase: any;
  fileRow: FileRow;
  storeRow: StoreRow;
  staffId: string;
}): Promise<EnsureMediaSummaryResult> {
  if (!isMediaMime(params.fileRow.mime_type)) {
    throw new Error('画像または動画ファイルのみ処理できます。');
  }

  const baseName = stripExtension(params.fileRow.display_name || 'media') || 'media';
  const summaryName = `${baseName}-analysis.txt`;

  const existingSummary = await findExistingSummary(params.admin, params.fileRow.file_store_id, summaryName);
  if (existingSummary) {
    if (isUnregisteredGeminiName(params.fileRow.gemini_file_name)) {
      await markOriginalFileAsProcessed(params.admin, params.fileRow.id, existingSummary.geminiFileName);
      params.fileRow.gemini_file_name = existingSummary.geminiFileName ?? params.fileRow.gemini_file_name;
    }
    return {
      status: 'already-exists',
      summaryName,
      summaryFile: existingSummary,
    };
  }

  const originalBuffer = await downloadOriginalFile(params.admin, params.fileRow);
  if (!originalBuffer.length) {
    throw new Error('保存されたファイルに内容がありません。');
  }

  const analysis = await analyzeInlineMediaWithGemini({
    buffer: originalBuffer,
    mimeType: params.fileRow.mime_type || 'application/octet-stream',
  });

  const summaryText = createMediaAnalysisSummary(params.fileRow.display_name || baseName, analysis);
  const summaryBuffer = Buffer.from(summaryText, 'utf8');

  const uploadResult = await uploadFileToStore({
    storeName: params.storeRow.gemini_store_name,
    fileBuffer: summaryBuffer,
    mimeType: SUMMARY_MIME_TYPE,
    displayName: summaryName,
    description: SUMMARY_DESCRIPTION,
  });

  const summaryRecord = await insertSummaryRecord(params.admin, params.supabase, {
    fileStoreId: params.fileRow.file_store_id,
    summaryName,
    summaryBuffer,
    geminiFileName: uploadResult.geminiFileName || null,
    staffId: params.staffId,
  });

  await markOriginalFileAsProcessed(params.admin, params.fileRow.id, summaryRecord.geminiFileName || uploadResult.geminiFileName);
  params.fileRow.gemini_file_name = summaryRecord.geminiFileName || uploadResult.geminiFileName || params.fileRow.gemini_file_name;

  return {
    status: 'created',
    summaryName,
    summaryFile: summaryRecord,
  };
}

export async function ensureImageSummaryForFile(params: {
  admin: any;
  supabase: any;
  fileRow: FileRow;
  storeRow: StoreRow;
  staffId: string;
}): Promise<EnsureMediaSummaryResult> {
  if (!isImageMime(params.fileRow.mime_type)) {
    throw new Error('画像ファイルのみ処理できます。');
  }
  return ensureMediaSummaryForFile(params);
}

export async function ensureVideoSummaryForFile(params: {
  admin: any;
  supabase: any;
  fileRow: FileRow;
  storeRow: StoreRow;
  staffId: string;
}): Promise<EnsureMediaSummaryResult> {
  if (!isVideoMime(params.fileRow.mime_type)) {
    throw new Error('動画ファイルのみ処理できます。');
  }
  return ensureTranscriptSummaryForFile(params, {
    description: VIDEO_TRANSCRIPT_DESCRIPTION,
    heading: VIDEO_TRANSCRIPT_HEADING,
    defaultBaseName: 'video',
    fallbackMime: 'video/mp4',
  });
}

export async function ensureAudioTranscriptForFile(params: {
  admin: any;
  supabase: any;
  fileRow: FileRow;
  storeRow: StoreRow;
  staffId: string;
}): Promise<EnsureAudioTranscriptResult> {
  if (!isAudioMime(params.fileRow.mime_type)) {
    throw new Error('音声ファイルのみ処理できます。');
  }
  return ensureTranscriptSummaryForFile(params, {
    description: AUDIO_TRANSCRIPT_DESCRIPTION,
    heading: AUDIO_TRANSCRIPT_HEADING,
    defaultBaseName: 'audio',
    fallbackMime: 'audio/mpeg',
  });
}

async function ensureTranscriptSummaryForFile(
  params: {
    admin: any;
    supabase: any;
    fileRow: FileRow;
    storeRow: StoreRow;
    staffId: string;
  },
  options: TranscriptOptions,
): Promise<EnsureAudioTranscriptResult> {
  const summarySuffix = options.summarySuffix || TRANSCRIPT_SUFFIX;
  const baseName = stripExtension(params.fileRow.display_name || options.defaultBaseName) || options.defaultBaseName;
  const summaryName = `${baseName}${summarySuffix}`;

  const existingSummary = await findExistingSummary(params.admin, params.fileRow.file_store_id, summaryName);
  if (existingSummary) {
    if (isUnregisteredGeminiName(params.fileRow.gemini_file_name)) {
      await markOriginalFileAsProcessed(params.admin, params.fileRow.id, existingSummary.geminiFileName);
      params.fileRow.gemini_file_name = existingSummary.geminiFileName ?? params.fileRow.gemini_file_name;
    }
    return {
      status: 'already-exists',
      summaryName,
      summaryFile: existingSummary,
    };
  }

  const originalBuffer = await downloadOriginalFile(params.admin, params.fileRow);
  if (!originalBuffer.length) {
    throw new Error('保存されたファイルに内容がありません。');
  }

  const transcriptText = await transcribeWithOpenAI({
    buffer: originalBuffer,
    fileName: params.fileRow.display_name || options.defaultBaseName,
    mimeType: params.fileRow.mime_type || options.fallbackMime,
    language: options.language || DEFAULT_TRANSCRIPT_LANGUAGE,
  });

  const transcriptDocument = createTranscriptDocument({
    heading: options.heading,
    originalName: params.fileRow.display_name || baseName,
    transcript: transcriptText,
  });
  const summaryBuffer = Buffer.from(transcriptDocument, 'utf8');

  const uploadResult = await uploadFileToStore({
    storeName: params.storeRow.gemini_store_name,
    fileBuffer: summaryBuffer,
    mimeType: SUMMARY_MIME_TYPE,
    displayName: summaryName,
    description: options.description,
  });

  const summaryRecord = await insertSummaryRecord(params.admin, params.supabase, {
    fileStoreId: params.fileRow.file_store_id,
    summaryName,
    summaryBuffer,
    geminiFileName: uploadResult.geminiFileName || null,
    staffId: params.staffId,
    description: options.description,
    mimeType: SUMMARY_MIME_TYPE,
  });

  await markOriginalFileAsProcessed(
    params.admin,
    params.fileRow.id,
    summaryRecord.geminiFileName || uploadResult.geminiFileName || null,
  );
  params.fileRow.gemini_file_name =
    summaryRecord.geminiFileName || uploadResult.geminiFileName || params.fileRow.gemini_file_name;

  return {
    status: 'created',
    summaryName,
    summaryFile: summaryRecord,
  };
}

export interface EnsureDocumentUploadResult {
  status: 'already-registered' | 'uploaded';
  geminiFileName: string | null;
}

export async function ensureDocumentUploadedForFile(params: {
  admin: any;
  fileRow: FileRow;
  storeRow: StoreRow;
}): Promise<EnsureDocumentUploadResult> {
  if (!isDocumentMime(params.fileRow.mime_type)) {
    throw new Error('ドキュメント系ファイルのみ処理できます。');
  }

  if (!isUnregisteredGeminiName(params.fileRow.gemini_file_name)) {
    return {
      status: 'already-registered',
      geminiFileName: params.fileRow.gemini_file_name ?? null,
    };
  }

  const originalBuffer = await downloadOriginalFile(params.admin, params.fileRow);
  if (!originalBuffer.length) {
    throw new Error('保存されたファイルに内容がありません。');
  }

  const uploadResult = await uploadFileToStore({
    storeName: params.storeRow.gemini_store_name,
    fileBuffer: originalBuffer,
    mimeType: params.fileRow.mime_type || 'application/octet-stream',
    displayName: params.fileRow.display_name,
    description: params.fileRow.description || undefined,
  });

  await markOriginalFileAsProcessed(params.admin, params.fileRow.id, uploadResult.geminiFileName || null);
  params.fileRow.gemini_file_name = uploadResult.geminiFileName || params.fileRow.gemini_file_name;

  return {
    status: 'uploaded',
    geminiFileName: uploadResult.geminiFileName || null,
  };
}
