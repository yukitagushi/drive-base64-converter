const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com';
const GEMINI_API_BASE = `${GEMINI_API_ROOT}/v1beta`;
const GEMINI_UPLOAD_BASE = `${GEMINI_API_ROOT}/upload/v1beta`;
const DEFAULT_LOCATION = process.env.GEMINI_LOCATION || 'global';

export class GeminiApiError extends Error {
  status?: number;
  debugId?: string | null;
  body?: any;

  constructor(message: string, options: { status?: number; debugId?: string | null; body?: any } = {}) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = options.status;
    this.debugId = options.debugId ?? null;
    this.body = options.body;
  }
}

interface GeminiStoreResponse {
  name: string;
  displayName?: string;
  createTime?: string;
  updateTime?: string;
}

interface GeminiFileResponse {
  name: string;
  displayName?: string;
  mimeType?: string;
  sizeBytes?: number | string;
  createTime?: string;
  updateTime?: string;
}

export interface GeminiStoreResult {
  storeName: string;
  displayName: string;
  createTime: string | null;
  updateTime: string | null;
}

export interface GeminiFileUploadResult {
  geminiFileName: string;
  displayName: string;
  mimeType: string | null;
  sizeBytes: number;
  createTime: string | null;
  updateTime: string | null;
}

function getApiKey(): string {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function ensureApiKey(): string {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Gemini File Search を利用するには GEMINI_API_KEY (または GOOGLE_API_KEY) が必要です。');
  }
  return apiKey;
}

function getProjectId(): string {
  return (
    process.env.GEMINI_PROJECT_ID ||
    process.env.GEMINI_PROJECT_NUMBER ||
    process.env.GOOGLE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    ''
  );
}

function ensureProjectId(): string {
  const projectId = getProjectId();
  if (!projectId) {
    throw new Error(
      'Gemini File Search を利用するには GEMINI_PROJECT_ID (または GOOGLE_PROJECT_ID / GOOGLE_CLOUD_PROJECT) を設定してください。'
    );
  }
  return projectId;
}

function ensureLocation(): string {
  const location = DEFAULT_LOCATION.trim();
  if (!location) {
    return 'global';
  }
  return location;
}

function ensureParentResource(): string {
  const projectId = ensureProjectId();
  const location = ensureLocation();
  return `projects/${projectId}/locations/${location}`;
}

function normalizeStore(entry: GeminiStoreResponse): GeminiStoreResult {
  return {
    storeName: entry.name || '',
    displayName: entry.displayName || deriveDisplayName(entry.name),
    createTime: entry.createTime || null,
    updateTime: entry.updateTime || null,
  };
}

function normalizeFile(entry: GeminiFileResponse): GeminiFileUploadResult {
  return {
    geminiFileName: entry.name || '',
    displayName: entry.displayName || deriveDisplayName(entry.name),
    mimeType: entry.mimeType || null,
    sizeBytes: typeof entry.sizeBytes === 'string' ? Number(entry.sizeBytes) : Number(entry.sizeBytes || 0),
    createTime: entry.createTime || null,
    updateTime: entry.updateTime || null,
  };
}

function deriveDisplayName(name?: string): string {
  if (!name) return '';
  const parts = String(name).split('/');
  return parts[parts.length - 1] || name;
}

function encodePath(value: string): string {
  return String(value)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function slugify(value?: string | null): string {
  if (!value) {
    return '';
  }
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function randomSlug(length = 16): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}

export function sanitizeStoreId(candidate?: string | null, fallbackName?: string | null): string {
  const attempts = [candidate, fallbackName];
  for (const value of attempts) {
    const slug = slugify(value);
    if (slug && slug.length >= 3) {
      return slug.slice(0, 64);
    }
  }

  const slug = `store-${randomSlug(18)}`;
  return slug.slice(0, 64);
}

function ensureStoreResourceName(nameOrId: string, displayName?: string): string {
  const trimmed = String(nameOrId || '').trim();
  if (!trimmed) {
    throw new Error('Gemini ストア名が指定されていません。');
  }

  if (trimmed.startsWith('projects/')) {
    return trimmed;
  }

  if (trimmed.startsWith('fileStores/')) {
    return `${ensureParentResource()}/${trimmed}`;
  }

  const slug = sanitizeStoreId(trimmed, displayName || undefined);
  return `${ensureParentResource()}/fileStores/${slug}`;
}

async function geminiFetch(url: string, init?: RequestInit) {
  const apiKey = ensureApiKey();
  const requestUrl = new URL(url, GEMINI_API_ROOT);
  if (!requestUrl.searchParams.has('key')) {
    requestUrl.searchParams.set('key', apiKey);
  }

  const headers = new Headers(init?.headers || {});
  if (!headers.has('x-goog-api-key')) {
    headers.set('x-goog-api-key', apiKey);
  }

  return fetch(requestUrl.toString(), {
    ...init,
    headers,
  });
}

function extractErrorMessage(data: any, fallback: string): string {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  if (data.error?.message) return data.error.message;
  if (data.message) return data.message;
  return fallback;
}

function extractDebugId(payload: any): string | null {
  const details = payload?.error?.details;
  if (Array.isArray(details) && details.length) {
    const debugInfo = details[0]?.debugInfo || details[0]?.debug_info;
    if (debugInfo) {
      return String(debugInfo);
    }
  }
  return payload?.error?.debugInfo || payload?.error?.debug_info || null;
}

function parsePayload(raw: string): any {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    return raw;
  }
}

export async function createFileStore(
  requestedId: string,
  displayName?: string
): Promise<GeminiStoreResult> {
  const slug = sanitizeStoreId(requestedId, displayName);
  const label = typeof displayName === 'string' ? displayName.trim() : '';
  const parent = ensureParentResource();
  const resourceName = `${parent}/fileStores/${slug}`;

  const body: Record<string, string> = {};
  if (label) {
    body.displayName = label;
  }

  const url = `${GEMINI_API_BASE}/${encodePath(parent)}/fileStores?fileStoreId=${encodeURIComponent(slug)}`;
  const response = await geminiFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  const payload = parsePayload(raw);

  if (response.status === 409) {
    console.warn('Gemini store already exists – treating as success.', {
      store: resourceName,
    });
    return {
      storeName: resourceName,
      displayName: label || slug,
      createTime: null,
      updateTime: null,
    };
  }

  if (!response.ok) {
    const message = extractErrorMessage(payload, 'Gemini ストアの作成に失敗しました。');
    const debugId = extractDebugId(payload);
    console.error('Gemini createFileStore error', {
      status: response.status,
      body: typeof raw === 'string' ? raw.slice(0, 512) : raw,
      debugId,
    });
    throw new GeminiApiError(`Gemini ストアの作成に失敗しました: ${response.status} ${message}`, {
      status: response.status,
      debugId,
      body: payload,
    });
  }

  const result = normalizeStore(payload as GeminiStoreResponse);
  if (!result.storeName) {
    result.storeName = resourceName;
  }

  console.info('Gemini store created:', {
    name: result.storeName,
    displayName: result.displayName,
  });

  return result;
}

export async function createFileStoreIfNeeded(
  storeId: string,
  displayName?: string
): Promise<GeminiStoreResult> {
  return createFileStore(storeId, displayName);
}

export async function uploadFileToStore(options: {
  storeName: string;
  fileBuffer: Buffer;
  mimeType?: string;
  displayName?: string;
  description?: string;
}): Promise<GeminiFileUploadResult> {
  if (!options.fileBuffer || !options.fileBuffer.length) {
    throw new Error('アップロードするファイルデータが見つかりません。');
  }

  const storeResource = ensureStoreResourceName(options.storeName, options.displayName);
  ensureParentResource();

  const metadata: Record<string, string> = {};
  if (options.displayName) {
    metadata.displayName = options.displayName;
  }
  if (options.description) {
    metadata.description = options.description;
  }

  const fileBytes = Buffer.isBuffer(options.fileBuffer)
    ? new Uint8Array(options.fileBuffer)
    : options.fileBuffer;

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    'file',
    new Blob([fileBytes], { type: options.mimeType || 'application/octet-stream' }),
    options.displayName || 'document'
  );

  const parent = ensureParentResource();
  const apiKey = ensureApiKey();
  const uploadUrl = `${GEMINI_UPLOAD_BASE}/files:upload?uploadType=multipart&parent=${encodeURIComponent(
    parent
  )}&key=${encodeURIComponent(apiKey)}`;
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
    },
    body: form,
  });

  const uploadText = await uploadResponse.text();
  const uploadPayload = parsePayload(uploadText);

  if (!uploadResponse.ok) {
    const message = extractErrorMessage(uploadPayload, 'Gemini へのアップロードに失敗しました。');
    const debugId = extractDebugId(uploadPayload);
    console.error('Gemini file upload error', {
      status: uploadResponse.status,
      body: typeof uploadText === 'string' ? uploadText.slice(0, 512) : uploadText,
      debugId,
    });
    throw new GeminiApiError(message, {
      status: uploadResponse.status,
      debugId,
      body: uploadPayload,
    });
  }

  const filePayload = (uploadPayload && (uploadPayload.file || uploadPayload)) as GeminiFileResponse;
  const result = normalizeFile(filePayload);

  if (!result.geminiFileName) {
    throw new GeminiApiError('Gemini へのアップロード結果にファイル名が含まれていません。', {
      status: uploadResponse.status,
      body: uploadPayload,
    });
  }

  await batchAddFilesToStore(storeResource, [result.geminiFileName]);

  console.info('Gemini file uploaded:', {
    name: result.geminiFileName,
    displayName: result.displayName,
    sizeBytes: result.sizeBytes,
    store: storeResource,
  });

  return result;
}

async function batchAddFilesToStore(storeResource: string, fileNames: string[]): Promise<void> {
  if (!fileNames.length) {
    return;
  }

  const body = {
    files: fileNames.map((file) => ({ file })),
  };

  const response = await geminiFetch(`${GEMINI_API_BASE}/${encodePath(storeResource)}:batchAddFiles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  const payload = parsePayload(raw);

  if (!response.ok) {
    const message = extractErrorMessage(payload, 'Gemini ストアへのファイル関連付けに失敗しました。');
    const debugId = extractDebugId(payload);
    console.error('Gemini batchAddFiles error', {
      status: response.status,
      body: typeof raw === 'string' ? raw.slice(0, 512) : raw,
      debugId,
    });
    throw new GeminiApiError(message, {
      status: response.status,
      debugId,
      body: payload,
    });
  }
}
