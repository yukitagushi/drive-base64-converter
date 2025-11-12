const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com';
const GEMINI_API_BASE = `${GEMINI_API_ROOT}/v1beta`;
const GEMINI_UPLOAD_BASE = `${GEMINI_API_ROOT}/upload/v1beta`;

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

export interface GeminiMediaAnalysisCandidate {
  text: string;
  finishReason: string | null;
  index: number | null;
}

export interface GeminiMediaAnalysisResult {
  text: string;
  model: string | null;
  candidates: GeminiMediaAnalysisCandidate[];
  usage?: Record<string, any> | null;
  raw?: any;
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

  if (trimmed.startsWith('fileSearchStores/')) {
    return trimmed;
  }

  const slug = sanitizeStoreId(trimmed, displayName || undefined);
  return `fileSearchStores/${slug}`;
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
  displayName: string
): Promise<GeminiStoreResult> {
  const label = typeof displayName === 'string' ? displayName.trim() : '';
  const body: Record<string, string> = {};
  if (label) {
    body.displayName = label;
  }

  const url = `${GEMINI_API_BASE}/fileSearchStores`;
  const response = await geminiFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  const payload = parsePayload(raw);

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
    throw new GeminiApiError('Gemini ストアの作成結果に識別子が含まれていません。', {
      status: response.status,
      body: payload,
    });
  }

  console.info('Gemini store created:', {
    name: result.storeName,
    displayName: result.displayName,
  });

  return result;
}

export async function createFileStoreIfNeeded(
  displayName: string,
  _options: { storeId?: string | null } = {}
): Promise<GeminiStoreResult> {
  return createFileStore(displayName);
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
  if (Object.keys(metadata).length) {
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  }
  form.append(
    'file',
    new Blob([fileBytes], { type: options.mimeType || 'application/octet-stream' }),
    options.displayName || 'document'
  );

  const apiKey = ensureApiKey();
  const uploadUrl = `${GEMINI_UPLOAD_BASE}/${encodePath(storeResource)}:uploadToFileSearchStore?uploadType=multipart&key=${encodeURIComponent(
    apiKey
  )}`;
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

  console.info('Gemini file uploaded:', {
    name: result.geminiFileName,
    displayName: result.displayName,
    sizeBytes: result.sizeBytes,
    store: storeResource,
  });

  return result;
}

export async function analyzeFileWithGemini(options: {
  geminiFileName: string;
  prompt?: string;
  mimeType?: string;
  model?: string;
}): Promise<GeminiMediaAnalysisResult> {
  const fileName = String(options.geminiFileName || '').trim();
  if (!fileName) {
    throw new Error('Gemini に渡すファイル名が指定されていません。');
  }

  const prompt = options.prompt?.trim() || 'このメディアの内容を要約し、重要なポイントと推奨アクションを日本語で提示してください。';
  const model = options.model || 'models/gemini-1.5-pro-latest';

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            fileData:
              options.mimeType && options.mimeType.trim()
                ? { fileUri: fileName, mimeType: options.mimeType }
                : { fileUri: fileName },
          },
        ],
      },
    ],
  };

  const url = `${GEMINI_API_BASE}/${encodePath(model)}:generateContent`;
  const response = await geminiFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const raw = await response.text();
  const payload = parsePayload(raw);

  if (!response.ok) {
    const message = extractErrorMessage(payload, 'Gemini メディア分析に失敗しました。');
    const debugId = extractDebugId(payload);
    console.error('Gemini analyzeFile error', {
      status: response.status,
      body: typeof raw === 'string' ? raw.slice(0, 512) : raw,
      debugId,
    });
    throw new GeminiApiError(`${message} (${response.status})`, {
      status: response.status,
      debugId,
      body: payload,
    });
  }

  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const normalizedCandidates: GeminiMediaAnalysisCandidate[] = candidates.map((candidate: any) => {
    const parts = candidate?.content?.parts || candidate?.content || [];
    const textParts: string[] = [];
    for (const part of parts) {
      if (part?.text) {
        textParts.push(String(part.text));
      }
    }
    const combined = textParts.join('\n').trim();
    return {
      text: combined,
      finishReason: candidate?.finishReason || candidate?.finish_reason || null,
      index: typeof candidate?.index === 'number' ? candidate.index : null,
    };
  });

  const primary = normalizedCandidates.find((candidate) => candidate.text) || null;

  return {
    text: primary?.text || '',
    model: payload?.modelVersion || payload?.model || null,
    candidates: normalizedCandidates,
    usage: payload?.usageMetadata || payload?.usage_metadata || null,
    raw: payload,
  };
}
