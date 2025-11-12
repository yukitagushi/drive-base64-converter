const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta';

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

async function geminiFetch(url: string, init?: RequestInit) {
  const apiKey = ensureApiKey();
  const hasQuery = url.includes('?');
  const finalUrl = `${url}${hasQuery ? '&' : '?'}key=${apiKey}`;
  return fetch(finalUrl, {
    ...init,
    headers: {
      ...(init?.headers || {}),
    },
  });
}

function extractErrorMessage(data: any, fallback: string): string {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  if (data.error?.message) return data.error.message;
  if (data.message) return data.message;
  return fallback;
}

export async function createFileStore(displayName: string): Promise<GeminiStoreResult> {
  const label = (displayName || '').trim();
  if (!label) {
    throw new Error('ストア名を入力してください。');
  }

  const response = await geminiFetch(`${GEMINI_API_BASE}/fileStores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: label }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = extractErrorMessage(payload, 'Gemini ストアの作成に失敗しました。');
    console.error('Gemini createFileStore error:', message, payload?.error || null);
    throw new Error(message);
  }

  const result = normalizeStore(payload as GeminiStoreResponse);
  console.info('Gemini store created:', {
    name: result.storeName,
    displayName: result.displayName,
  });
  return result;
}

export async function createFileStoreIfNeeded(displayName: string): Promise<GeminiStoreResult> {
  // The File Search API does not currently expose a lookup by display name, so we always create a new store.
  return createFileStore(displayName);
}

export async function uploadFileToStore(options: {
  storeName: string;
  fileBuffer: Buffer;
  mimeType?: string;
  displayName?: string;
  description?: string;
}): Promise<GeminiFileUploadResult> {
  const storeName = (options.storeName || '').trim();
  if (!storeName) {
    throw new Error('アップロード先ストアが指定されていません。');
  }
  if (!options.fileBuffer || !options.fileBuffer.length) {
    throw new Error('アップロードするファイルデータが見つかりません。');
  }

  const metadata: Record<string, string> = {};
  if (options.displayName) {
    metadata.displayName = options.displayName;
  }
  if (options.description) {
    metadata.description = options.description;
  }

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([options.fileBuffer], { type: options.mimeType || 'application/octet-stream' }), options.displayName || 'document');

  const response = await geminiFetch(
    `${GEMINI_UPLOAD_BASE}/${encodePath(storeName)}/files:upload?uploadType=multipart`,
    {
      method: 'POST',
      body: form,
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = extractErrorMessage(payload, 'Gemini へのアップロードに失敗しました。');
    console.error('Gemini uploadFileToStore error:', message, payload?.error || null);
    throw new Error(message);
  }

  const filePayload = (payload && (payload.file || payload)) as GeminiFileResponse;
  const result = normalizeFile(filePayload);
  console.info('Gemini file uploaded:', {
    name: result.geminiFileName,
    displayName: result.displayName,
    sizeBytes: result.sizeBytes,
  });
  return result;
}
