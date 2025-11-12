import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import {
  getSupabaseBearerToken,
  resolveStaffForRequest,
} from '../lib/api-auth';
import { getSupabaseClientWithToken } from '../lib/supabaseClient';
import { GeminiApiError, uploadFileToStore } from '../lib/gemini';

const DEFAULT_UPLOAD_BUCKET = 'gemini-upload-cache';
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 60MB safety cap for server-side processing

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
    console.error('Error in /api/documents:', error);
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

  const contentTypeHeader = String(
    (req.headers['content-type'] || req.headers['Content-Type'] || '') as string
  ).toLowerCase();

  if (contentTypeHeader.includes('application/json')) {
    await handleJsonUpload(req, res, {
      supabase,
      admin,
      staff,
    });
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

  if (!fileStoreId && !fileStoreNameField) {
    respond(res, 400, { error: 'fileStoreId または fileStoreName を指定してください。' });
    return;
  }

  const fileEntry = files.file || files.document || Object.values(files)[0];
  if (!fileEntry) {
    respond(res, 400, { error: 'ファイルを選択してください。' });
    return;
  }

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

  const uploadResult = await uploadFileToStore({
    storeName: storeRow.gemini_store_name,
    fileBuffer: fileEntry.data,
    mimeType: fileEntry.contentType,
    displayName: displayNameField || fileEntry.filename,
    description: memo,
  });

  const insertPayload = {
    file_store_id: storeRow.id,
    gemini_file_name: uploadResult.geminiFileName,
    display_name: uploadResult.displayName || fileEntry.filename,
    description: memo || null,
    size_bytes: uploadResult.sizeBytes || fileEntry.data.length,
    mime_type: uploadResult.mimeType || fileEntry.contentType,
    uploaded_by: staff.id,
  };

  const { data, error } = await supabase
    .from('file_store_files')
    .insert(insertPayload)
    .select('id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, uploaded_by, uploaded_at')
    .single();

  if (error) {
    console.error('Supabase file insert error:', error.message);
    throw new Error(error.message);
  }

  res.status(201).json({
    item: {
      id: data.id,
      fileStoreId: data.file_store_id,
      geminiFileName: data.gemini_file_name,
      displayName: data.display_name,
      description: data.description,
      sizeBytes: data.size_bytes,
      mimeType: data.mime_type,
      uploadedBy: data.uploaded_by,
      uploadedAt: data.uploaded_at,
    },
    gemini: uploadResult,
  });
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
  }
) {
  const rawBuffer = await readRequestBody(req);
  const rawText = rawBuffer.toString('utf8').trim();

  if (!rawText) {
    respond(res, 400, { error: 'リクエスト本文が空です。' });
    return;
  }

  let payload: JsonUploadPayload;
  try {
    payload = JSON.parse(rawText);
  } catch (error: any) {
    respond(res, 400, { error: 'JSON の解析に失敗しました。' });
    return;
  }

  const fileStoreId = payload.fileStoreId || payload.file_store_id || '';
  const fileStoreName = payload.fileStoreName || payload.file_store_name || payload.geminiStoreName || '';

  if (!fileStoreId && !fileStoreName) {
    respond(res, 400, { error: 'fileStoreId または fileStoreName を指定してください。' });
    return;
  }

  const storageBucket = payload.storageBucket || payload.bucket || DEFAULT_UPLOAD_BUCKET;
  const storagePath = payload.storagePath || payload.path || '';

  if (!storageBucket || !storagePath) {
    respond(res, 400, { error: 'storageBucket と storagePath を指定してください。' });
    return;
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
    return;
  }

  const storeRow = resolvedStore.storeRow;
  const bucket = storageBucket;
  const path = storagePath;

  const download = await context.admin.storage.from(bucket).download(path);
  if (download.error) {
    respond(res, 400, { error: download.error.message || 'Supabase ストレージからの取得に失敗しました。' });
    return;
  }

  const downloadData = download.data;
  if (!downloadData) {
    respond(res, 400, { error: 'アップロードされたファイルを取得できませんでした。' });
    return;
  }

  const arrayBuffer = await downloadData.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);

  if (!fileBuffer.length) {
    respond(res, 400, { error: 'アップロードされたファイルに内容がありません。' });
    return;
  }

  if (fileBuffer.length > MAX_UPLOAD_BYTES) {
    respond(res, 413, { error: 'アップロードされたファイルが大きすぎます。' });
    return;
  }

  const memo = payload.memo || payload.description || '';
  const displayName = payload.displayName || payload.filename || 'document';
  const mimeType = payload.mimeType || payload.contentType || 'application/octet-stream';

  const uploadResult = await uploadFileToStore({
    storeName: storeRow.gemini_store_name,
    fileBuffer,
    mimeType,
    displayName,
    description: memo,
  });

  const insertPayload = {
    file_store_id: storeRow.id,
    gemini_file_name: uploadResult.geminiFileName,
    display_name: uploadResult.displayName || displayName,
    description: memo || null,
    size_bytes: uploadResult.sizeBytes || payload.sizeBytes || fileBuffer.length,
    mime_type: uploadResult.mimeType || mimeType,
    uploaded_by: context.staff.id,
  };

  const { data, error } = await context.supabase
    .from('file_store_files')
    .insert(insertPayload)
    .select(
      'id, file_store_id, gemini_file_name, display_name, description, size_bytes, mime_type, uploaded_by, uploaded_at'
    )
    .single();

  if (error) {
    console.error('Supabase file insert error:', error.message);
    throw new Error(error.message);
  }

  try {
    await context.admin.storage.from(bucket).remove([path]);
  } catch (cleanupError: any) {
    console.warn('Failed to clean up staged upload:', cleanupError?.message || cleanupError);
  }

  res.status(201).json({
    item: {
      id: data.id,
      fileStoreId: data.file_store_id,
      geminiFileName: data.gemini_file_name,
      displayName: data.display_name,
      description: data.description,
      sizeBytes: data.size_bytes,
      mimeType: data.mime_type,
      uploadedBy: data.uploaded_by,
      uploadedAt: data.uploaded_at,
    },
    gemini: uploadResult,
  });
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
  const { supabase, admin, staff, res } = params;
  let { fileStoreId = '', fileStoreName = '' } = params;

  fileStoreId = (fileStoreId || '').trim();
  fileStoreName = (fileStoreName || '').trim();

  let storeRow = null;
  let storeError = null;

  if (fileStoreId) {
    const { data, error } = await supabase
      .from('file_stores')
      .select('id, gemini_store_name, organization_id, office_id')
      .eq('id', fileStoreId)
      .maybeSingle();
    storeRow = data;
    storeError = error;
  } else if (fileStoreName) {
    const { data, error } = await supabase
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
    throw new Error(storeError.message);
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
