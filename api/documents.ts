import type { VercelRequest, VercelResponse } from '@vercel/node';
import { extname } from 'node:path';
import JSZip from 'jszip';
import type { JSZipObject } from 'jszip';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import {
  getSupabaseBearerToken,
  resolveStaffForRequest,
} from '../lib/api-auth';
import { getSupabaseClientWithToken } from '../lib/supabaseClient';
import {
  analyzeFileWithGemini,
  analyzeInlineMediaWithGemini,
  GeminiApiError,
  ensureGeminiEnvironment,
  uploadFileToStore,
  type GeminiFileUploadResult,
  type GeminiMediaAnalysisResult,
} from '../lib/gemini';
import { ensureStorageBucket } from '../lib/storage';

const DEFAULT_UPLOAD_BUCKET = 'gemini-upload-cache';
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 60MB safety cap for server-side processing
const MAX_ZIP_EXTRACT_FILES = 200;
const MAX_ZIP_EXTRACT_BYTES = 50 * 1024 * 1024; // avoid exploding archives on the server

const ZIP_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip',
]);

const TEXTUAL_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'tsv',
  'xml',
  'html',
  'htm',
  'yaml',
  'yml',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'java',
  'c',
  'cpp',
  'cs',
  'sql',
  'log',
]);

const TEXTUAL_MIME_HINTS = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/yaml',
  'application/x-yaml',
  'application/x-sh',
  'application/sql',
  'application/csv',
  'application/vnd.ms-excel',
]);

const IMAGE_PREFIX = 'image/';
const VIDEO_PREFIX = 'video/';

const GENERIC_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
  'unknown/unknown',
]);

const EXTENSION_MIME_MAP = new Map<string, string>([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['bmp', 'image/bmp'],
  ['webp', 'image/webp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['avif', 'image/avif'],
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['qt', 'video/quicktime'],
  ['avi', 'video/x-msvideo'],
  ['webm', 'video/webm'],
  ['mkv', 'video/x-matroska'],
  ['mpg', 'video/mpeg'],
  ['mpeg', 'video/mpeg'],
  ['mpg4', 'video/mp4'],
  ['3gp', 'video/3gpp'],
  ['3g2', 'video/3gpp2'],
  ['zip', 'application/zip'],
]);

const STORE_ONLY_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12',
]);

const STORE_ONLY_EXTENSIONS = new Set(['zip', 'xlsx', 'xls', 'xlsm', 'xlsb']);

const GEMINI_STORE_FAILURE_NOTE = 'Gemini File Search 登録に失敗しましたが、ファイルは保存されました。';
const GEMINI_ANALYSIS_FAILURE_NOTE = 'Gemini 解析に失敗しましたが、ファイルは保存しました。';

function getExtension(filename?: string | null): string {
  const ext = extname(String(filename || '')).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

function stripExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  if (index <= 0) {
    return filename;
  }
  return filename.slice(0, index);
}

function compactGeminiBody(body: any): any {
  if (body == null) {
    return null;
  }
  if (typeof body === 'string') {
    return body.length > 2000 ? `${body.slice(0, 2000)}…` : body;
  }
  try {
    const serialized = JSON.stringify(body);
    if (serialized.length > 2000) {
      return `${serialized.slice(0, 2000)}…`;
    }
  } catch {
    // ignore JSON stringify errors and fall back to the original body.
  }
  return body;
}

function serializeGeminiError(error: unknown): Record<string, any> {
  if (error instanceof GeminiApiError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status ?? null,
      debugId: error.debugId ?? null,
      body: compactGeminiBody(error.body),
    };
  }

  if (error instanceof Error) {
    const responseSummary = (() => {
      const anyError = error as any;
      const response = anyError?.response;
      if (!response) {
        return undefined;
      }
      try {
        return {
          status: response.status,
          statusText: response.statusText,
        };
      } catch {
        return undefined;
      }
    })();

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      response: responseSummary,
    };
  }

  return { value: error };
}

function logGeminiError(message: string, error: unknown, context: Record<string, any> = {}) {
  console.error(message, {
    ...context,
    geminiError: serializeGeminiError(error),
  });
}

function isZipType(mimeType: string, extension: string): boolean {
  return ZIP_MIME_TYPES.has(mimeType) || extension === 'zip';
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith(IMAGE_PREFIX);
}

function isVideoMime(mimeType: string): boolean {
  return mimeType.startsWith(VIDEO_PREFIX);
}

function normalizeMimeCandidate(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() || '';
}

function isGenericMime(mimeType: string): boolean {
  return GENERIC_MIME_TYPES.has(normalizeMimeCandidate(mimeType));
}

function detectMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 4) {
    return null;
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') {
      return 'image/gif';
    }
  }

  if (buffer.length >= 4) {
    const ascii4 = buffer.subarray(0, 4).toString('ascii');
    if (ascii4 === 'RIFF' && buffer.length >= 12) {
      const riffType = buffer.subarray(8, 12).toString('ascii');
      if (riffType === 'WEBP') {
        return 'image/webp';
      }
      if (riffType === 'AVI ') {
        return 'video/x-msvideo';
      }
    }
    if (buffer.length >= 12) {
      const boxType = buffer.subarray(4, 8).toString('ascii');
      if (boxType === 'ftyp') {
        const brand = buffer.subarray(8, 12).toString('ascii');
        const trimmed = brand.trim();
        const lower = trimmed.toLowerCase();
        if (
          [
            'isom',
            'iso2',
            'mp41',
            'mp42',
            'avc1',
            'msnv',
            'ndas',
            'f4v',
            'm4v',
            '3gp5',
            '3g2a',
          ].includes(lower)
        ) {
          return 'video/mp4';
        }
        if (lower === 'qt' || brand === 'qt  ') {
          return 'video/quicktime';
        }
        if (lower.startsWith('he') || lower === 'mif1' || lower === 'msf1') {
          return 'image/heic';
        }
        if (lower.startsWith('avif')) {
          return 'image/avif';
        }
      }
    }
  }

  if (buffer.length >= 4) {
    const tiffLittleEndian = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
    const tiffBigEndian = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;
    if (tiffLittleEndian || tiffBigEndian) {
      return 'image/tiff';
    }
  }

  if (buffer.length >= 2) {
    const bmp = buffer[0] === 0x42 && buffer[1] === 0x4d;
    if (bmp) {
      return 'image/bmp';
    }
  }

  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0xba) {
    return 'video/mpeg';
  }

  return null;
}

function resolveMimeType({
  buffer,
  mimeType,
  extension,
}: {
  buffer: Buffer;
  mimeType: string;
  extension: string;
}): string {
  let candidate = normalizeMimeCandidate(mimeType);
  if (!isGenericMime(candidate)) {
    return candidate;
  }

  if (extension) {
    const mapped = EXTENSION_MIME_MAP.get(extension);
    if (mapped) {
      return mapped;
    }
  }

  const detected = detectMimeTypeFromBuffer(buffer);
  if (detected) {
    return detected;
  }

  return candidate || 'application/octet-stream';
}

function isTextExtension(extension: string): boolean {
  return TEXTUAL_EXTENSIONS.has(extension);
}

function isProbablyTextMime(mimeType: string, extension: string): boolean {
  const normalized = normalizeMimeCandidate(mimeType);
  if (!normalized || normalized === 'application/octet-stream') {
    return isTextExtension(extension);
  }
  if (normalized.startsWith('text/')) {
    return true;
  }
  return TEXTUAL_MIME_HINTS.has(normalized) || isTextExtension(extension);
}

function sanitizeZipEntryDisplayName(name: string, fallbackIndex: number, extension: string): string {
  const cleaned = name
    .replace(/^\.\/+/, '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\]+/g, '/')
    .trim();
  const safeSegments = cleaned
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '..');
  const normalized = safeSegments.join('__').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const safeBase = normalized.slice(-240);
  let candidate = safeBase || `extracted-file-${fallbackIndex + 1}`;
  if (!candidate.includes('.') && extension) {
    candidate = `${candidate}.${extension}`;
  }
  return candidate || `extracted-file-${fallbackIndex + 1}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function appendDescription(base: string | null, extra: string | null): string | null {
  const trimmedBase = base?.trim() || '';
  const trimmedExtra = extra?.trim() || '';
  if (trimmedBase && trimmedExtra) {
    return `${trimmedBase}\n${trimmedExtra}`;
  }
  return trimmedBase || trimmedExtra || null;
}

function applyCors(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string | undefined) || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
}

function respond(res: VercelResponse, status: number, payload: Record<string, any>) {
  res.status(status).json({ source: 'api', status, ...payload });
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

interface MultipartFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

interface MultipartResult {
  fields: Record<string, string>;
  files: Record<string, MultipartFile>;
}

interface NormalizedFileRecord {
  id: string;
  fileStoreId: string;
  geminiFileName: string;
  displayName: string;
  description: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  uploadedBy: string | null;
  uploadedAt: string | null;
}

interface UploadOutcome {
  items: NormalizedFileRecord[];
  gemini: GeminiFileUploadResult[];
  analyses: GeminiMediaAnalysisResult[];
  notes: string[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  try {
    if (req.method === 'GET') {
      await handleGet(req, res);
      return;
    }

    if (req.method === 'POST') {
      await handlePost(req, res);
      return;
    }

    res.setHeader('Allow', 'GET,POST,OPTIONS');
    respond(res, 405, { error: 'Method Not Allowed' });
  } catch (error: any) {
    logGeminiError('Error in /api/documents:', error);
    if (handleKnownError(res, error)) {
      return;
    }
    respond(res, 500, { error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const token = getSupabaseBearerToken(req);
  if (!token) {
    respond(res, 401, { error: '認証が必要です。' });
    return;
  }

  const supabase = getSupabaseClientWithToken(token);
  const admin = getSupabaseAdmin();
  const staff = await resolveStaffForRequest(admin, req);
  if (!staff) {
    respond(res, 403, { error: 'スタッフ情報が見つかりません。' });
    return;
  }

  const query = req.query as Record<string, string | string[] | undefined>;
  const fileStoreId = firstValue(query.fileStoreId);

  if (!fileStoreId) {
    respond(res, 400, { error: 'fileStoreId は必須です。' });
    return;
  }

  const { data: storeRow, error: storeSelectError } = await supabase
    .from('file_stores')
    .select('id, office_id')
    .eq('id', fileStoreId)
    .maybeSingle();

  if (storeSelectError) {
    throw new Error(storeSelectError.message);
  }

  if (!storeRow) {
    const access = await classifyStoreAccess(admin, fileStoreId, staff.officeId || null);
    if (access === 'forbidden') {
      respond(res, 403, { error: 'このストアにはアクセスできません。' });
      return;
    }
    respond(res, 404, { error: '指定したストアが見つかりません。' });
    return;
  }

  const { data, error } = await supabase
    .from('file_store_files')
    .select('id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, uploaded_by, uploaded_at')
    .eq('file_store_id', fileStoreId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const items = (data || []).map((row) => ({
    id: row.id,
    fileStoreId: row.file_store_id,
    geminiFileName: row.gemini_file_name,
    displayName: row.display_name,
    description: row.description,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  }));

  res.status(200).json({ items });
}

async function handlePost(req: VercelRequest, res: VercelResponse) {
  const token = getSupabaseBearerToken(req);
  if (!token) {
    respond(res, 401, { error: '認証が必要です。' });
    return;
  }

  const supabase = getSupabaseClientWithToken(token);
  const admin = getSupabaseAdmin();
  const staff = await resolveStaffForRequest(admin, req);
  if (!staff?.officeId) {
    respond(res, 403, { error: 'スタッフ情報が見つかりません。' });
    return;
  }

  try {
    const env = ensureGeminiEnvironment();
    console.info('Gemini environment resolved for upload request.', {
      projectId: env.projectId,
      location: env.location,
    });
  } catch (error: any) {
    logGeminiError('Gemini environment validation failed.', error);
    respond(res, 500, {
      error:
        error?.message ||
        'Gemini の環境変数 (GEMINI_API_KEY, GEMINI_PROJECT_ID, GEMINI_LOCATION) を確認してください。',
    });
    return;
  }

  const contentTypeHeader = String(
    (req.headers['content-type'] || req.headers['Content-Type'] || '') as string
  ).toLowerCase();

  const catchContext: Record<string, any> = {
    contentType: contentTypeHeader,
  };
  let normalizedMimeForCatch: string | null = null;

  try {
    if (contentTypeHeader.includes('application/json')) {
      catchContext.uploadKind = 'json';
      const outcome = await handleJsonUpload(req, res, {
        supabase,
        admin,
        staff,
        onMimeResolved: (mime: string) => {
          normalizedMimeForCatch = mime;
          catchContext.mimeType = mime;
        },
      });
      if (outcome) {
        res.status(201).json(outcome);
      }
      return;
    }

    let parsed: MultipartResult;
    try {
      parsed = await parseMultipartForm(req);
    } catch (error: any) {
      respond(res, 400, { error: error?.message || 'multipart/form-data でファイルを送信してください。' });
      return;
    }

    const { fields, files } = parsed;
    let fileStoreId = fields.fileStoreId || fields.file_store_id || '';
    const fileStoreNameField =
      fields.fileSearchStoreName || fields.file_store_name || fields.fileStoreName || fields.geminiStoreName || '';
    const memo = fields.memo || fields.description || '';
    const displayNameField = fields.displayName || fields.filename || '';

    catchContext.fileStoreId = fileStoreId;
    catchContext.fileStoreName = fileStoreNameField;
    catchContext.uploadKind = 'multipart';

    if (!fileStoreId && !fileStoreNameField) {
      respond(res, 400, { error: 'fileStoreId または fileStoreName を指定してください。' });
      return;
    }

    const fileEntry = files.file || files.document || Object.values(files)[0];
    if (!fileEntry) {
      respond(res, 400, { error: 'ファイルを選択してください。' });
      return;
    }

    catchContext.originalFilename = fileEntry.filename;
    catchContext.guessedMimeType = fileEntry.contentType;

    const resolvedStore = await resolveStoreForUpload({
      supabase,
      admin,
      staff,
      res,
      fileStoreId,
      fileStoreName: fileStoreNameField,
    });
    if (!resolvedStore) {
      return;
    }

    fileStoreId = resolvedStore.storeId;
    const storeRow = resolvedStore.storeRow;

    const outcome = await processUploadBuffer({
      admin,
      supabase,
      staffId: staff.id,
      storeRow,
      fileBuffer: fileEntry.data,
      originalFilename: displayNameField || fileEntry.filename,
      displayName: displayNameField || fileEntry.filename,
      mimeType: fileEntry.contentType || 'application/octet-stream',
      memo,
      onMimeResolved: (mime: string) => {
        normalizedMimeForCatch = mime;
        catchContext.mimeType = mime;
      },
    });

    res.status(201).json(outcome);
  } catch (error: any) {
    if (normalizedMimeForCatch) {
      catchContext.mimeType = normalizedMimeForCatch;
    }
    logGeminiError('handlePost failed', error, catchContext);
    const serializedError = serializeGeminiError(error);
    if (error instanceof GeminiApiError && error.status === 404) {
      respond(res, 400, { error: 'file_store_not_found', geminiError: serializedError });
      return;
    }
    respond(res, 500, { error: 'upload_failed', geminiError: serializedError });
  }
}

interface JsonUploadPayload {
  fileStoreId?: string;
  file_store_id?: string;
  fileStoreName?: string;
  file_store_name?: string;
  geminiStoreName?: string;
  storageBucket?: string;
  bucket?: string;
  storagePath?: string;
  path?: string;
  displayName?: string;
  filename?: string;
  memo?: string;
  description?: string;
  mimeType?: string;
  contentType?: string;
  sizeBytes?: number;
}

async function handleJsonUpload(
  req: VercelRequest,
  res: VercelResponse,
  context: {
    supabase: ReturnType<typeof getSupabaseClientWithToken>;
    admin: ReturnType<typeof getSupabaseAdmin>;
    staff: Awaited<ReturnType<typeof resolveStaffForRequest>>;
    onMimeResolved?: (mime: string) => void;
  }
): Promise<UploadOutcome | null> {
  const rawBuffer = await readRequestBody(req);
  const rawText = rawBuffer.toString('utf8').trim();

  if (!rawText) {
    respond(res, 400, { error: 'リクエスト本文が空です。' });
    return null;
  }

  let payload: JsonUploadPayload;
  try {
    payload = JSON.parse(rawText);
  } catch (error: any) {
    respond(res, 400, { error: 'JSON の解析に失敗しました。' });
    return null;
  }

  const fileStoreId = payload.fileStoreId || payload.file_store_id || '';
  const fileStoreName = payload.fileStoreName || payload.file_store_name || payload.geminiStoreName || '';

  if (!fileStoreId && !fileStoreName) {
    respond(res, 400, { error: 'fileStoreId または fileStoreName を指定してください。' });
    return null;
  }

  const storageBucket = payload.storageBucket || payload.bucket || DEFAULT_UPLOAD_BUCKET;
  const storagePath = payload.storagePath || payload.path || '';

  if (!storageBucket || !storagePath) {
    respond(res, 400, { error: 'storageBucket と storagePath を指定してください。' });
    return null;
  }

  const resolvedStore = await resolveStoreForUpload({
    supabase: context.supabase,
    admin: context.admin,
    staff: context.staff,
    res,
    fileStoreId,
    fileStoreName,
  });

  if (!resolvedStore) {
    return null;
  }

  const storeRow = resolvedStore.storeRow;
  const bucket = storageBucket;
  const path = storagePath;

  await ensureStorageBucket({ bucket, admin: context.admin, sizeLimitBytes: MAX_UPLOAD_BYTES });

  const download = await context.admin.storage.from(bucket).download(path);
  if (download.error) {
    respond(res, 400, { error: download.error.message || 'Supabase ストレージからの取得に失敗しました。' });
    return null;
  }

  const downloadData = download.data;
  if (!downloadData) {
    respond(res, 400, { error: 'アップロードされたファイルを取得できませんでした。' });
    return null;
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = await bufferFromUnknown(downloadData);
  } catch (error: any) {
    respond(res, 500, {
      error:
        error?.message ||
        'Supabase ストレージから取得したファイルを処理できませんでした。',
    });
    return null;
  }

  if (!fileBuffer.length) {
    respond(res, 400, { error: 'アップロードされたファイルに内容がありません。' });
    return null;
  }

  if (fileBuffer.length > MAX_UPLOAD_BYTES) {
    respond(res, 413, { error: 'アップロードされたファイルが大きすぎます。' });
    return null;
  }

  const memo = payload.memo || payload.description || '';
  const displayName = payload.displayName || payload.filename || 'document';
  const mimeType = payload.mimeType || payload.contentType || 'application/octet-stream';
  let outcome: UploadOutcome;
  try {
    outcome = await processUploadBuffer({
      admin: context.admin,
      supabase: context.supabase,
      staffId: context.staff.id,
      storeRow,
      fileBuffer,
      originalFilename: displayName,
      displayName,
      mimeType,
      memo,
      onMimeResolved: context.onMimeResolved,
    });
  } finally {
    try {
      await context.admin.storage.from(bucket).remove([path]);
    } catch (cleanupError: any) {
      console.warn('Failed to clean up staged upload:', cleanupError?.message || cleanupError);
    }
  }

  return outcome;
}

interface UploadBufferContext {
  admin: ReturnType<typeof getSupabaseAdmin>;
  supabase: ReturnType<typeof getSupabaseClientWithToken>;
  staffId: string;
  storeRow: { id: string; gemini_store_name: string };
  fileBuffer: Buffer;
  originalFilename: string;
  displayName: string;
  mimeType: string;
  memo: string;
  onMimeResolved?: (mime: string) => void;
}

interface UploadRecordParams {
  admin: ReturnType<typeof getSupabaseAdmin>;
  supabase: ReturnType<typeof getSupabaseClientWithToken>;
  storeRow: { id: string; gemini_store_name: string };
  staffId: string;
  baseDescription: string | null;
  buffer: Buffer;
  displayName: string;
  mimeType: string;
  extraDescription?: string | null;
}

async function processUploadBuffer(context: UploadBufferContext): Promise<UploadOutcome> {
  const items: NormalizedFileRecord[] = [];
  const gemini: GeminiFileUploadResult[] = [];
  const analyses: GeminiMediaAnalysisResult[] = [];
  const notes: string[] = [];
  const pushNote = (note: string) => {
    if (note && !notes.includes(note)) {
      notes.push(note);
    }
  };

  const extension = getExtension(context.originalFilename || context.displayName);
  const normalizedMime = resolveMimeType({
    buffer: context.fileBuffer,
    mimeType: context.mimeType || 'application/octet-stream',
    extension,
  }).toLowerCase();
  context.onMimeResolved?.(normalizedMime);
  const baseDescription = context.memo?.trim() ? context.memo.trim() : null;
  const shouldBypassMediaEnrichment =
    STORE_ONLY_MIME_TYPES.has(normalizedMime) || STORE_ONLY_EXTENSIONS.has(extension);

  const upload = async (params: {
    buffer: Buffer;
    displayName: string;
    mimeType: string;
    extraDescription?: string | null;
  }) => {
    const result = await uploadAndRecordGeminiFile({
      admin: context.admin,
      supabase: context.supabase,
      storeRow: context.storeRow,
      staffId: context.staffId,
      baseDescription,
      buffer: params.buffer,
      displayName: params.displayName,
      mimeType: params.mimeType,
      extraDescription: params.extraDescription || null,
    });
    items.push(result.record);
    gemini.push(result.gemini);
    if (!result.gemini.geminiFileName) {
      pushNote(GEMINI_STORE_FAILURE_NOTE);
    }
    return result;
  };

  if (!shouldBypassMediaEnrichment && isZipType(normalizedMime, extension)) {
    await upload({
      buffer: context.fileBuffer,
      displayName: context.displayName,
      mimeType: normalizedMime,
    });

    let extraction: ZipExtractionResult;
    try {
      extraction = await extractZipArchive(context.fileBuffer, context.originalFilename);
    } catch (error: any) {
      throw new Error(error?.message || 'ZIP アーカイブの展開に失敗しました。');
    }

    for (const [index, file] of extraction.extractedFiles.entries()) {
      await upload({
        buffer: file.buffer,
        displayName: file.displayName || `extracted-${index + 1}`,
        mimeType: file.mimeType || 'application/octet-stream',
        extraDescription: file.description,
      });
    }

    const extractedName = `${stripExtension(context.displayName || context.originalFilename) || context.displayName}-extracted.txt`;
    const summaryDescription = extraction.summaryDescriptionLines.length
      ? extraction.summaryDescriptionLines.join('\n')
      : 'ZIP アーカイブから抽出したテキストです。';

    await upload({
      buffer: Buffer.from(extraction.summaryText, 'utf8'),
      displayName: extractedName,
      mimeType: 'text/plain; charset=utf-8',
      extraDescription: summaryDescription,
    });

    extraction.userNotes.forEach((note) => {
      if (note && !notes.includes(note)) {
        notes.push(note);
      }
    });
  } else if (!shouldBypassMediaEnrichment && isImageMime(normalizedMime)) {
    let analysis: GeminiMediaAnalysisResult | null = null;
    let analysisFailed = false;
    try {
      analysis = await analyzeInlineMediaWithGemini({
        buffer: context.fileBuffer,
        mimeType: normalizedMime,
      });
    } catch (error: any) {
      analysisFailed = true;
      logGeminiError('Gemini inline media analysis failed. Falling back to stored file workflow.', error, {
        mimeType: normalizedMime,
        displayName: context.displayName,
      });
    }

    const original = await upload({
      buffer: context.fileBuffer,
      displayName: context.displayName,
      mimeType: normalizedMime,
    });
    const canAnalyzeStored = Boolean(original.gemini.geminiFileName);

    if (!analysis && canAnalyzeStored) {
      try {
        analysis = await analyzeFileWithGemini({
          geminiFileName: original.gemini.geminiFileName,
          geminiFileUri: original.gemini.geminiFileUri,
          mimeType: normalizedMime,
        });
        analysisFailed = false;
      } catch (error: any) {
        analysisFailed = true;
        logGeminiError('Gemini stored media analysis failed for image.', error, {
          geminiFileName: original.gemini.geminiFileName,
          geminiFileUri: original.gemini.geminiFileUri,
          mimeType: normalizedMime,
        });
      }
    }

    if (analysis) {
      analyses.push(analysis);

      if (canAnalyzeStored) {
        const summaryText = createMediaAnalysisSummary(context.originalFilename, analysis);
        const summaryName = `${stripExtension(context.displayName || context.originalFilename) || context.displayName}-analysis.txt`;

        await upload({
          buffer: Buffer.from(summaryText, 'utf8'),
          displayName: summaryName,
          mimeType: 'text/plain; charset=utf-8',
          extraDescription: 'Gemini によるメディア解析テキストです。',
        });

        pushNote('Gemini がメディアを解析しテキストを生成しました。');
      }
    } else if (analysisFailed) {
      pushNote(GEMINI_ANALYSIS_FAILURE_NOTE);
    }
  } else if (!shouldBypassMediaEnrichment && isVideoMime(normalizedMime)) {
    const original = await upload({
      buffer: context.fileBuffer,
      displayName: context.displayName,
      mimeType: normalizedMime,
    });
    const canAnalyzeStored = Boolean(original.gemini.geminiFileName);

    let analysis: GeminiMediaAnalysisResult | null = null;
    if (canAnalyzeStored) {
      try {
        analysis = await analyzeFileWithGemini({
          geminiFileName: original.gemini.geminiFileName,
          geminiFileUri: original.gemini.geminiFileUri,
          mimeType: normalizedMime,
        });
      } catch (error: any) {
        logGeminiError('Gemini stored media analysis failed for video.', error, {
          geminiFileName: original.gemini.geminiFileName,
          geminiFileUri: original.gemini.geminiFileUri,
          mimeType: normalizedMime,
        });
      }
    }

    if (analysis) {
      analyses.push(analysis);

      if (canAnalyzeStored) {
        const summaryText = createMediaAnalysisSummary(context.originalFilename, analysis);
        const summaryName = `${stripExtension(context.displayName || context.originalFilename) || context.displayName}-analysis.txt`;

        await upload({
          buffer: Buffer.from(summaryText, 'utf8'),
          displayName: summaryName,
          mimeType: 'text/plain; charset=utf-8',
          extraDescription: 'Gemini によるメディア解析テキストです。',
        });

        pushNote('Gemini がメディアを解析しテキストを生成しました。');
      }
    } else if (canAnalyzeStored) {
      pushNote(GEMINI_ANALYSIS_FAILURE_NOTE);
    }
  } else {
    await upload({
      buffer: context.fileBuffer,
      displayName: context.displayName,
      mimeType: normalizedMime,
    });
    if (shouldBypassMediaEnrichment && (isZipType(normalizedMime, extension) || STORE_ONLY_EXTENSIONS.has(extension))) {
      pushNote('Gemini File Search 用にファイルをそのまま保存しました。');
    }
  }

  return { items, gemini, analyses, notes };
}

async function uploadAndRecordGeminiFile(params: UploadRecordParams): Promise<{
  record: NormalizedFileRecord;
  gemini: GeminiFileUploadResult;
}> {
  const description = appendDescription(params.baseDescription, params.extraDescription || null);
  const uploadResult = await uploadFileToStore({
    storeName: params.storeRow.gemini_store_name,
    fileBuffer: params.buffer,
    mimeType: params.mimeType,
    displayName: params.displayName,
    description: description || undefined,
  });

  const insertPayload = {
    file_store_id: params.storeRow.id,
    gemini_file_name: uploadResult.geminiFileName,
    display_name: uploadResult.displayName || params.displayName,
    description: description,
    size_bytes: uploadResult.sizeBytes || params.buffer.length,
    mime_type: uploadResult.mimeType || params.mimeType,
    uploaded_by: params.staffId,
  };

  const { data: adminInserted, error: adminInsertError } = await params.admin
    .from('file_store_files')
    .insert(insertPayload)
    .select(
      'id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, uploaded_by, uploaded_at'
    )
    .single();

  if (adminInsertError) {
    console.error('Supabase file insert error:', adminInsertError.message);
    throw new Error(adminInsertError.message);
  }

  const { data: readerRow, error: readerError } = await params.supabase
    .from('file_store_files')
    .select(
      'id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, uploaded_by, uploaded_at'
    )
    .eq('id', adminInserted.id)
    .maybeSingle();

  if (readerError) {
    console.warn('Failed to read back inserted row with user client:', readerError.message);
  }

  const record = normalizeFileRecord(readerRow || adminInserted);

  return { record, gemini: uploadResult };
}

interface ZipExtractedFileRecord {
  buffer: Buffer;
  displayName: string;
  mimeType: string;
  description: string | null;
}

interface ZipExtractionResult {
  summaryText: string;
  summaryDescriptionLines: string[];
  extractedFiles: ZipExtractedFileRecord[];
  userNotes: string[];
}

async function extractZipArchive(buffer: Buffer, originalName: string): Promise<ZipExtractionResult> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer);
  } catch (error: any) {
    throw new Error(`ZIP ファイルの展開に失敗しました: ${error?.message || error}`);
  }

  const entries: JSZipObject[] = Object.values(archive.files || {});
  if (!entries.length) {
    return {
      summaryText: `# ZIP 展開レポート: ${originalName}\n\n(アーカイブ内にファイルが見つかりませんでした。)`,
      summaryDescriptionLines: ['ZIP アーカイブから抽出したテキストです。'],
      extractedFiles: [],
      userNotes: ['ZIP アーカイブを展開しましたが、ファイルは含まれていませんでした。'],
    };
  }

  const extractedFiles: ZipExtractedFileRecord[] = [];
  const textSections: string[] = [];
  const nonTextEntries: string[] = [];
  const skippedByLimit: string[] = [];
  const failedEntries: string[] = [];

  let processedCount = 0;
  let totalExtractedBytes = 0;

  for (const entry of entries) {
    if (!entry || entry.dir) {
      continue;
    }

    const entryName = entry.name || 'unknown';
    let entryBuffer: Buffer;
    try {
      const raw = await (entry as any).async('uint8array');
      entryBuffer = Buffer.from(raw);
    } catch (error: any) {
      failedEntries.push(`${entryName} (${error?.message || error})`);
      continue;
    }

    const entryExt = getExtension(entryName);
    const normalizedMime = resolveMimeType({
      buffer: entryBuffer,
      mimeType: '',
      extension: entryExt,
    }).toLowerCase();

    if (
      processedCount >= MAX_ZIP_EXTRACT_FILES ||
      totalExtractedBytes + entryBuffer.length > MAX_ZIP_EXTRACT_BYTES
    ) {
      skippedByLimit.push(`${entryName} (${formatBytes(entryBuffer.length)})`);
      continue;
    }

    const sanitizedName = sanitizeZipEntryDisplayName(entryName, processedCount, entryExt);
    const description = `ZIP アーカイブ ${originalName} から抽出したファイルです。元のパス: ${entryName}`;

    extractedFiles.push({
      buffer: entryBuffer,
      displayName: sanitizedName,
      mimeType: normalizedMime,
      description,
    });

    processedCount += 1;
    totalExtractedBytes += entryBuffer.length;

    if (isProbablyTextMime(normalizedMime, entryExt)) {
      const content = entryBuffer.toString('utf8');
      textSections.push(`## ${entryName}\n${content}`.trim());
    } else {
      nonTextEntries.push(entryName);
    }
  }

  if (!textSections.length) {
    textSections.push('(テキストファイルを展開できませんでした。)');
  }

  let summary = `# ZIP 展開レポート: ${originalName}`;
  summary += `\n\n${textSections.join('\n\n')}`;

  if (nonTextEntries.length) {
    summary += `\n\n---\nテキスト変換されなかったファイル:\n${nonTextEntries
      .map((name) => `- ${name}`)
      .join('\n')}`;
  }

  if (skippedByLimit.length) {
    summary += `\n\n---\nサイズや件数の制限で抽出されなかったファイル:\n${skippedByLimit
      .map((name) => `- ${name}`)
      .join('\n')}`;
  }

  if (failedEntries.length) {
    summary += `\n\n---\n読み取りに失敗したファイル:\n${failedEntries
      .map((name) => `- ${name}`)
      .join('\n')}`;
  }

  const summaryDescriptionLines = ['ZIP アーカイブから抽出したテキストです。'];
  if (nonTextEntries.length) {
    summaryDescriptionLines.push('一部のファイルはバイナリ形式のためテキスト化せず一覧化しています。');
  }
  if (skippedByLimit.length) {
    summaryDescriptionLines.push(
      `サイズまたは件数の制限で ${skippedByLimit.length} 件のファイルをスキップしました。`
    );
  }
  if (failedEntries.length) {
    summaryDescriptionLines.push(`${failedEntries.length} 件のファイルは読み取りに失敗しました。`);
  }

  const userNotes: string[] = [];
  userNotes.push('ZIP アーカイブを展開してテキスト化しました。');
  if (extractedFiles.length) {
    userNotes.push(`ZIP アーカイブから ${extractedFiles.length} 件のファイルを保存しました。`);
  }
  if (skippedByLimit.length) {
    userNotes.push(`サイズまたは件数の制限で ${skippedByLimit.length} 件のファイルをスキップしました。`);
  }
  if (failedEntries.length) {
    userNotes.push(`${failedEntries.length} 件のファイルの読み取りに失敗しました。`);
  }

  return {
    summaryText: summary,
    summaryDescriptionLines,
    extractedFiles,
    userNotes,
  };
}

function createMediaAnalysisSummary(
  originalName: string,
  analysis: GeminiMediaAnalysisResult
): string {
  const lines: string[] = [];
  lines.push(`# Gemini メディア解析レポート`);
  lines.push(`対象ファイル: ${originalName}`);
  if (analysis.model) {
    lines.push(`モデル: ${analysis.model}`);
  }

  if (analysis.text) {
    lines.push('', analysis.text.trim());
  }

  if (analysis.candidates.length > 1) {
    lines.push('', '---', '追加候補:');
    analysis.candidates.forEach((candidate, index) => {
      const label = `候補 ${index + 1}`;
      const detail: string[] = [`## ${label}`];
      if (candidate.text) {
        detail.push(candidate.text.trim());
      }
      if (candidate.finishReason) {
        detail.push(`(finishReason: ${candidate.finishReason})`);
      }
      lines.push('', detail.join('\n'));
    });
  }

  if (analysis.usage) {
    lines.push('', '---', 'トークン使用量:', JSON.stringify(analysis.usage, null, 2));
  }

  return lines.join('\n');
}

function normalizeFileRecord(row: any): NormalizedFileRecord {
  return {
    id: row?.id || '',
    fileStoreId: row?.file_store_id || '',
    geminiFileName: row?.gemini_file_name || '',
    displayName: row?.display_name || '',
    description: row?.description ?? null,
    sizeBytes:
      typeof row?.size_bytes === 'number'
        ? row.size_bytes
        : row?.size_bytes
        ? Number(row.size_bytes)
        : null,
    mimeType: row?.mime_type || null,
    uploadedBy: row?.uploaded_by || null,
    uploadedAt: row?.uploaded_at || null,
  };
}

interface ResolveStoreParams {
  supabase: ReturnType<typeof getSupabaseClientWithToken>;
  admin: ReturnType<typeof getSupabaseAdmin>;
  staff: Awaited<ReturnType<typeof resolveStaffForRequest>>;
  res: VercelResponse;
  fileStoreId?: string | null;
  fileStoreName?: string | null;
}

interface ResolvedStore {
  storeId: string;
  storeRow: {
    id: string;
    gemini_store_name: string;
    organization_id: string | null;
    office_id: string | null;
  };
}

async function resolveStoreForUpload(params: ResolveStoreParams): Promise<ResolvedStore | null> {
  const { admin, staff, res } = params;
  let { fileStoreId = '', fileStoreName = '' } = params;

  fileStoreId = (fileStoreId || '').trim();
  fileStoreName = (fileStoreName || '').trim();

  let storeRow = null;
  let storeError = null;

  if (fileStoreId) {
    const { data, error } = await admin
      .from('file_stores')
      .select('id, gemini_store_name, organization_id, office_id')
      .eq('id', fileStoreId)
      .maybeSingle();
    storeRow = data;
    storeError = error;
  } else if (fileStoreName) {
    const { data, error } = await admin
      .from('file_stores')
      .select('id, gemini_store_name, organization_id, office_id')
      .eq('gemini_store_name', fileStoreName)
      .maybeSingle();
    storeRow = data;
    storeError = error;
    if (data?.id) {
      fileStoreId = data.id;
    }
  }

  if (storeError) {
    console.error('Supabase file store lookup error:', storeError);
    respond(res, 500, { error: 'ファイルストアの取得に失敗しました。' });
    return null;
  }

  if (!storeRow) {
    const access = await classifyStoreAccess(admin, fileStoreId, staff.officeId || null);
    if (access === 'forbidden') {
      respond(res, 403, { error: 'このストアにはアクセスできません。' });
      return null;
    }
    respond(res, 404, { error: '指定したストアが見つかりません。' });
    return null;
  }

  if (fileStoreName && storeRow.gemini_store_name !== fileStoreName) {
    respond(res, 400, { error: '送信された fileStoreName が一致しません。' });
    return null;
  }

  if (storeRow.office_id !== staff.officeId) {
    respond(res, 403, { error: 'このストアにはアクセスできません。' });
    return null;
  }

  return {
    storeId: storeRow.id,
    storeRow,
  };
}

async function parseMultipartForm(req: VercelRequest): Promise<MultipartResult> {
  const contentType = (req.headers['content-type'] || req.headers['Content-Type']) as string | undefined;
  if (!contentType || !contentType.startsWith('multipart/form-data')) {
    throw new Error('multipart/form-data でファイルを送信してください。');
  }

  const boundaryMatch = contentType.match(/boundary=(?:("?)([^";]+)\1)/i);
  const boundaryKey = boundaryMatch ? boundaryMatch[2] : null;
  if (!boundaryKey) {
    throw new Error('multipart の boundary が見つかりません。');
  }

  const bodyBuffer = await readRequestBody(req);
  const boundary = Buffer.from(`--${boundaryKey}`);
  const closeBoundary = Buffer.from(`--${boundaryKey}--`);
  const delimiter = Buffer.from('\r\n\r\n');

  const fields: Record<string, string> = {};
  const files: Record<string, MultipartFile> = {};

  let position = bodyBuffer.indexOf(boundary);
  if (position === -1) {
    return { fields, files };
  }

  position += boundary.length;

  while (position < bodyBuffer.length) {
    if (bodyBuffer[position] === 13 && bodyBuffer[position + 1] === 10) {
      position += 2;
    }

    if (bodyBuffer.slice(position, position + closeBoundary.length).equals(closeBoundary)) {
      break;
    }

    const nextBoundaryIndex = bodyBuffer.indexOf(boundary, position);
    const nextCloseIndex = bodyBuffer.indexOf(closeBoundary, position);
    let partEnd = nextBoundaryIndex;
    let isFinal = false;

    if (nextBoundaryIndex === -1 || (nextCloseIndex !== -1 && nextCloseIndex < nextBoundaryIndex)) {
      partEnd = nextCloseIndex;
      isFinal = true;
    }

    if (partEnd === -1) {
      partEnd = bodyBuffer.length;
    }

    let partBuffer = bodyBuffer.slice(position, partEnd);
    if (partBuffer.length >= 2 && partBuffer[partBuffer.length - 2] === 13 && partBuffer[partBuffer.length - 1] === 10) {
      partBuffer = partBuffer.slice(0, -2);
    }

    const headerEnd = partBuffer.indexOf(delimiter);
    if (headerEnd === -1) {
      if (isFinal) break;
      position = partEnd + boundary.length;
      continue;
    }

    const headerBuffer = partBuffer.slice(0, headerEnd);
    const body = partBuffer.slice(headerEnd + delimiter.length);
    const headerText = headerBuffer.toString('utf8');
    const headers = parseHeaders(headerText);

    const disposition = headers['content-disposition'];
    if (!disposition) {
      if (isFinal) break;
      position = partEnd + boundary.length;
      continue;
    }

    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    const fieldName = nameMatch ? nameMatch[1] : '';

    if (!fieldName) {
      if (isFinal) break;
      position = partEnd + boundary.length;
      continue;
    }

    if (filenameMatch) {
      const filename = filenameMatch[1] || 'file';
      const contentType = headers['content-type'] || 'application/octet-stream';
      files[fieldName] = {
        filename,
        contentType,
        data: body,
      };
    } else {
      fields[fieldName] = body.toString('utf8');
    }

    if (isFinal) {
      break;
    }

    position = partEnd + boundary.length;
  }

  return { fields, files };
}

function parseHeaders(raw: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[key] = value;
  }
  return headers;
}

async function readRequestBody(req: VercelRequest): Promise<Buffer> {
  const existing = (req as any).body;
  if (existing && Buffer.isBuffer(existing)) {
    return existing as Buffer;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function bufferFromUnknown(value: any): Promise<Buffer> {
  if (!value) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  if (typeof value === 'string') {
    return Buffer.from(value);
  }

  if (typeof value.arrayBuffer === 'function') {
    const arrayBuffer = await value.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  if (typeof value.text === 'function') {
    const text = await value.text();
    return Buffer.from(text);
  }

  if (typeof value.stream === 'function') {
    const stream = value.stream();
    if (stream && typeof stream.getReader === 'function') {
      const reader = stream.getReader();
      const parts: Buffer[] = [];
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) {
          break;
        }
        if (chunk) {
          parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      }
      return Buffer.concat(parts);
    }
  }

  if (typeof value[Symbol.asyncIterator] === 'function') {
    const parts: Buffer[] = [];
    for await (const chunk of value as AsyncIterable<any>) {
      if (!chunk) {
        continue;
      }
      if (Buffer.isBuffer(chunk)) {
        parts.push(chunk);
      } else if (chunk instanceof ArrayBuffer) {
        parts.push(Buffer.from(chunk));
      } else if (ArrayBuffer.isView(chunk)) {
        parts.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      } else if (typeof chunk === 'string') {
        parts.push(Buffer.from(chunk));
      } else {
        parts.push(Buffer.from(chunk as any));
      }
    }
    return Buffer.concat(parts);
  }

  throw new Error('サポートされていないデータ形式です。');
}

async function classifyStoreAccess(admin: any, fileStoreId: string, staffOfficeId: string | null) {
  if (!fileStoreId) {
    return null;
  }
  try {
    const { data } = await admin
      .from('file_stores')
      .select('office_id')
      .eq('id', fileStoreId)
      .maybeSingle();
    if (!data) {
      return 'not_found';
    }
    if (staffOfficeId && data.office_id !== staffOfficeId) {
      return 'forbidden';
    }
    return 'ok';
  } catch (error: any) {
    console.error('store access lookup failed:', error?.message || error);
    return null;
  }
}

function handleKnownError(res: VercelResponse, error: any): boolean {
  if (error instanceof GeminiApiError) {
    const status = error.status ?? 500;
    res.status(status).json({
      source: 'gemini',
      error: error.message,
      status,
      debugId: error.debugId ?? null,
    });
    return true;
  }
  return false;
}
