import type { VercelRequest, VercelResponse } from '@vercel/node';
import { extname } from 'node:path';
import {
  analyzeInlineMediaWithGemini,
  uploadFileToStore,
  GeminiApiError,
} from '../lib/gemini';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import {
  getSupabaseBearerToken,
  resolveStaffForRequest,
} from '../lib/api-auth';
import { getSupabaseClientWithToken } from '../lib/supabaseClient';

const DEFAULT_STORAGE_BUCKET_CANDIDATES = [
  'file-store-files',
  'gemini-upload-cache',
];
const SUMMARY_DESCRIPTION = 'Gemini による画像解析テキストです。';
const SUMMARY_MIME_TYPE = 'text/plain; charset=utf-8';
const API_NAME = '/api/gemini-register-image-summary';

interface FileRow {
  id: string;
  file_store_id: string;
  gemini_file_name: string;
  display_name: string;
  description: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  storage_object_path?: string | null;
}

interface StoreRow {
  id: string;
  gemini_store_name: string;
  office_id: string | null;
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

function normalizeMime(value: string | null | undefined): string {
  return (value || '').split(';')[0]?.trim().toLowerCase() || '';
}

function isImageMime(mimeType: string | null | undefined): boolean {
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
      console.warn(`${API_NAME} failed to stringify usage payload`, error);
    }
  }

  return lines.join('\n');
}

function serializeGeminiError(error: unknown): Record<string, any> | null {
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

function serializeSupabaseError(error: { table: string; operation: string; supabaseError: any } | null) {
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

class SupabaseActionError extends Error {
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
    const trimmed = typeof entry === 'string' ? entry.trim().replace(/^\/+|\/+$|^\.+/g, '') : '';
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
        // Continue trying the next candidate.
        continue;
      }
    }
  }
  throw new Error('保存されたファイルを取得できませんでした。');
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

    const baseName = stripExtension(fileRow.display_name || 'image') || 'image';
    const summaryName = `${baseName}-analysis.txt`;

    const existingSummary = await findExistingSummary(admin, fileRow.file_store_id, summaryName);
    if (existingSummary) {
      respond(res, 200, {
        success: true,
        alreadyProcessed: true,
        fileId: fileRow.id,
        summaryFile: {
          id: existingSummary.id,
          displayName: existingSummary.display_name,
          geminiFileName: existingSummary.gemini_file_name,
        },
      });
      return;
    }

    const originalBuffer = await downloadOriginalFile(admin, fileRow);
    if (!originalBuffer.length) {
      throw new Error('保存されたファイルに内容がありません。');
    }

    const analysis = await analyzeInlineMediaWithGemini({
      buffer: originalBuffer,
      mimeType: fileRow.mime_type || 'application/octet-stream',
    });

    const summaryText = createMediaAnalysisSummary(fileRow.display_name || baseName, analysis);
    const summaryBuffer = Buffer.from(summaryText, 'utf8');

    const uploadResult = await uploadFileToStore({
      storeName: storeRow.gemini_store_name,
      fileBuffer: summaryBuffer,
      mimeType: SUMMARY_MIME_TYPE,
      displayName: summaryName,
      description: SUMMARY_DESCRIPTION,
    });

    const summaryRecord = await insertSummaryRecord(admin, supabase, {
      fileStoreId: fileRow.file_store_id,
      summaryName,
      summaryBuffer,
      geminiFileName: uploadResult.geminiFileName,
      staffId: staff.id,
    });

    respond(res, 200, {
      success: true,
      fileId: fileRow.id,
      summaryFile: {
        id: summaryRecord.id,
        displayName: summaryRecord.displayName,
        geminiFileName: summaryRecord.geminiFileName,
      },
    });
  } catch (error: any) {
    const status = error instanceof GeminiApiError ? error.status ?? 500 : 500;
    console.error(`${API_NAME} error:`, error);
    respond(
      res,
      status,
      {
        error: 'register_image_summary_failed',
        message: error?.message || '画像解析テキストの登録に失敗しました。',
        geminiError: serializeGeminiError(error instanceof GeminiApiError ? error : null),
        supabaseError: error instanceof SupabaseActionError ? serializeSupabaseError(error) : null,
      },
    );
  }
}

async function fetchFileRow(admin: any, fileId: string): Promise<FileRow | null> {
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

async function fetchStoreRow(admin: any, storeId: string): Promise<StoreRow | null> {
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

async function findExistingSummary(admin: any, storeId: string, displayName: string) {
  const { data, error } = await admin
    .from('file_store_files')
    .select('id, display_name, gemini_file_name')
    .eq('file_store_id', storeId)
    .eq('display_name', displayName)
    .maybeSingle();
  if (error) {
    throw new SupabaseActionError('file_store_files', 'select', error);
  }
  return data;
}

async function insertSummaryRecord(
  admin: any,
  supabase: any,
  params: {
    fileStoreId: string;
    summaryName: string;
    summaryBuffer: Buffer;
    geminiFileName: string;
    staffId: string;
  },
): Promise<{ id: string; displayName: string; geminiFileName: string }> {
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
      console.warn(`${API_NAME} failed to refresh user-facing view`, readerError);
    }
  }

  return {
    id: inserted.id,
    displayName: inserted.display_name,
    geminiFileName: inserted.gemini_file_name,
  };
}

