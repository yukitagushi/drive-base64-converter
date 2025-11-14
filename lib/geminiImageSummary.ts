import { extname } from 'node:path';
import {
  analyzeInlineMediaWithGemini,
  uploadFileToStore,
  GeminiApiError,
} from './gemini';

export const SUMMARY_DESCRIPTION = 'Gemini による画像解析テキストです。';
export const SUMMARY_MIME_TYPE = 'text/plain; charset=utf-8';
const DEFAULT_STORAGE_BUCKET_CANDIDATES = ['file-store-files', 'gemini-upload-cache'];

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

export interface EnsureImageSummaryResult {
  status: 'already-exists' | 'created';
  summaryName: string;
  summaryFile: SummaryRecord;
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
      console.warn('geminiImageSummary failed to stringify usage payload', error);
    }
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

async function downloadOriginalFile(admin: any, file: FileRow): Promise<Buffer> {
  const pathCandidates = buildStoragePathCandidates(file);
  const bucketCandidates = new Set<string>();

  if (file.storage_bucket) {
    bucketCandidates.add(String(file.storage_bucket));
  }
  DEFAULT_STORAGE_BUCKET_CANDIDATES.forEach((bucket) => bucketCandidates.add(bucket));

  for (const bucket of bucketCandidates) {
    for (const path of pathCandidates) {
      try {
        const response = await admin.storage.from(bucket).download(path);
        if (response.error) {
          continue;
        }
        const buffer = await bufferFromUnknown(response.data);
        if (buffer.length) {
          return buffer;
        }
      } catch (error) {
        continue;
      }
    }
  }

  throw new Error('保存されたファイルを取得できませんでした。');
}

export async function fetchFileRow(admin: any, fileId: string): Promise<FileRow | null> {
  const { data, error } = await admin
    .from('file_store_files')
    .select(
      'id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, storage_bucket, storage_path, storage_object_path',
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
  },
): Promise<SummaryRecord> {
  const insertPayload = {
    file_store_id: params.fileStoreId,
    gemini_file_name: params.geminiFileName,
    display_name: params.summaryName,
    description: SUMMARY_DESCRIPTION,
    size_bytes: params.summaryBuffer.length,
    mime_type: SUMMARY_MIME_TYPE,
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
      console.warn('geminiImageSummary failed to refresh user-facing view', readerError);
    }
  }

  return {
    id: inserted.id,
    displayName: inserted.display_name,
    geminiFileName: inserted.gemini_file_name,
  };
}

export async function ensureImageSummaryForFile(params: {
  admin: any;
  supabase: any;
  fileRow: FileRow;
  storeRow: StoreRow;
  staffId: string;
}): Promise<EnsureImageSummaryResult> {
  if (!isImageMime(params.fileRow.mime_type)) {
    throw new Error('画像ファイルのみ処理できます。');
  }

  const baseName = stripExtension(params.fileRow.display_name || 'image') || 'image';
  const summaryName = `${baseName}-analysis.txt`;

  const existingSummary = await findExistingSummary(params.admin, params.fileRow.file_store_id, summaryName);
  if (existingSummary) {
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

  return {
    status: 'created',
    summaryName,
    summaryFile: summaryRecord,
  };
}
