const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com';
const GEMINI_API_BASE = `${GEMINI_API_ROOT}/v1beta`;
const GEMINI_UPLOAD_BASE = `${GEMINI_API_ROOT}/upload/v1beta`;

export interface GeminiEnvironmentConfig {
  apiKey: string;
  projectId: string | null;
  location: string | null;
}

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

function readProjectId(): string | null {
  return (
    process.env.GEMINI_PROJECT_ID ||
    process.env.GOOGLE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    null
  );
}

function readLocation(): string | null {
  return (
    process.env.GEMINI_LOCATION ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    process.env.GOOGLE_CLOUD_REGION ||
    null
  );
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

export function readGeminiEnvironment(): GeminiEnvironmentConfig {
  return {
    apiKey: getApiKey(),
    projectId: readProjectId(),
    location: readLocation(),
  };
}

export function ensureGeminiEnvironment(options: {
  requireApiKey?: boolean;
  requireProject?: boolean;
  requireLocation?: boolean;
} = {}): GeminiEnvironmentConfig {
  const { requireApiKey = true, requireProject = true, requireLocation = true } = options;
  const env = readGeminiEnvironment();

  if (requireApiKey && !env.apiKey) {
    throw new Error('Gemini API キーが設定されていません。GEMINI_API_KEY または GOOGLE_API_KEY を確認してください。');
  }

  if (requireProject && !env.projectId) {
    throw new Error(
      'Gemini プロジェクト ID が設定されていません。GEMINI_PROJECT_ID (または GOOGLE_PROJECT_ID / GOOGLE_CLOUD_PROJECT) を確認してください。'
    );
  }

  if (requireLocation && !env.location) {
    throw new Error(
      'Gemini のロケーションが設定されていません。GEMINI_LOCATION (または GOOGLE_CLOUD_LOCATION / GOOGLE_CLOUD_REGION) を確認してください。'
    );
  }

  return env;
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

  const env = readGeminiEnvironment();
  const projectId = env.projectId?.trim();
  const location = env.location?.trim();

  const ensurePrefix = (slug: string): string => {
    if (projectId && location) {
      return `projects/${projectId}/locations/${location}/fileSearchStores/${slug}`;
    }
    return `fileSearchStores/${slug}`;
  };

  if (trimmed.startsWith('fileSearchStores/')) {
    const slug = trimmed.slice('fileSearchStores/'.length);
    return ensurePrefix(slug);
  }

  const slug = sanitizeStoreId(trimmed, displayName || undefined);
  return ensurePrefix(slug);
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

export async function createFileStore(displayName: string): Promise<GeminiStoreResult> {
  const label = typeof displayName === 'string' ? displayName.trim() : '';
  const body: Record<string, string> = {};
  if (label) {
    body.displayName = label;
  }

  const env = ensureGeminiEnvironment();
  const parentSegments = env.projectId && env.location ? `projects/${env.projectId}/locations/${env.location}` : '';
  const url = parentSegments
    ? `${GEMINI_API_BASE}/${encodePath(`${parentSegments}/fileSearchStores`)}`
    : `${GEMINI_API_BASE}/fileSearchStores`;
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
  // NOTE: Gemini's upload metadata currently rejects unknown fields such as
  // "description", so we persist descriptions only in Supabase instead of the
  // API payload to avoid 400 Invalid JSON errors.

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

function normalizeModelId(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith('models/') ? trimmed : `models/${trimmed}`;
}

const INLINE_MEDIA_MAX_BYTES = 20 * 1024 * 1024; // 20MB safety cap for inline Gemini requests

function toBuffer(data: Buffer | ArrayBuffer | ArrayBufferView | ArrayLike<number>): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }
  if (typeof (data as ArrayLike<number>)?.length === 'number') {
    return Buffer.from(data as ArrayLike<number>);
  }
  throw new Error('Gemini に渡すメディアデータをバッファに変換できません。');
}

type GeminiMediaSource =
  | {
      kind: 'file';
      fileName: string;
      mimeType?: string;
    }
  | {
      kind: 'inline';
      base64Data: string;
      mimeType: string;
    };

function buildMediaPromptParts({
  media,
  prompt,
}: {
  media: GeminiMediaSource;
  prompt: string;
}) {
  const parts: any[] = [];
  if (media.kind === 'file') {
    const fileData: Record<string, string> = { fileUri: media.fileName };
    if (media.mimeType && media.mimeType.trim()) {
      fileData.mimeType = media.mimeType.trim();
    }
    parts.push({ fileData });
  } else {
    parts.push({ inlineData: { data: media.base64Data, mimeType: media.mimeType } });
  }

  if (prompt) {
    parts.push({ text: prompt });
  }
  return parts;
}

function getDefaultModelOrder(mimeType?: string | null): string[] {
  const defaults = ['models/gemini-2.5-flash'];
  const fallback = 'models/gemini-1.5-pro-latest';
  if (mimeType && mimeType.startsWith('video/')) {
    // The 1.5 Pro models generally provide better temporal reasoning for video.
    return [fallback, defaults[0]];
  }
  return [...defaults, fallback];
}

function shouldRetryModel(error: any): boolean {
  if (!(error instanceof GeminiApiError)) {
    return false;
  }
  if (!error.status) {
    return true;
  }
  return error.status >= 500 || error.status === 429;
}

async function invokeMediaAnalysis({
  model,
  media,
  prompt,
}: {
  model: string;
  media: GeminiMediaSource;
  prompt: string;
}): Promise<GeminiMediaAnalysisResult> {
  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: buildMediaPromptParts({ media, prompt }),
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
      model,
      media,
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
    model: payload?.modelVersion || payload?.model || model,
    candidates: normalizedCandidates,
    usage: payload?.usageMetadata || payload?.usage_metadata || null,
    raw: payload,
  };
}

export async function analyzeFileWithGemini(options: {
  geminiFileName: string;
  prompt?: string;
  mimeType?: string;
  model?: string;
  modelFallbacks?: string[];
}): Promise<GeminiMediaAnalysisResult> {
  const fileName = String(options.geminiFileName || '').trim();
  if (!fileName) {
    throw new Error('Gemini に渡すファイル名が指定されていません。');
  }

  const prompt =
    options.prompt?.trim() ||
    'このメディアの内容を要約し、重要なポイントと推奨アクションを日本語で提示してください。';

  const preferred = normalizeModelId(options.model);
  const fallbackList = (options.modelFallbacks || []).map((model) => normalizeModelId(model)).filter(Boolean) as string[];
  const orderedModels = preferred
    ? [preferred, ...fallbackList]
    : [...getDefaultModelOrder(options.mimeType), ...fallbackList];

  let lastError: any = null;
  for (const candidate of orderedModels) {
    if (!candidate) {
      continue;
    }
    try {
      return await invokeMediaAnalysis({
        model: candidate,
        media: {
          kind: 'file',
          fileName,
          mimeType: options.mimeType,
        },
        prompt,
      });
    } catch (error: any) {
      lastError = error;
      if (!shouldRetryModel(error)) {
        throw error;
      }
      console.warn(`Gemini モデル ${candidate} での解析に失敗しました。フォールバックを試します。`, {
        error: error instanceof Error ? error.message : error,
      });
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('利用可能な Gemini モデルが選択されていません。');
}

export async function analyzeInlineMediaWithGemini(options: {
  buffer: Buffer | ArrayBuffer | ArrayBufferView | ArrayLike<number>;
  mimeType: string;
  prompt?: string;
  model?: string;
  modelFallbacks?: string[];
  maxBytes?: number;
}): Promise<GeminiMediaAnalysisResult> {
  const mimeType = String(options.mimeType || '').trim();
  if (!mimeType) {
    throw new Error('Gemini に渡すメディアの MIME タイプが指定されていません。');
  }

  const buffer = toBuffer(options.buffer);
  if (!buffer.length) {
    throw new Error('Gemini に渡すメディアデータが空です。');
  }

  const limit = typeof options.maxBytes === 'number' ? options.maxBytes : INLINE_MEDIA_MAX_BYTES;
  if (buffer.length > limit) {
    throw new Error(`Gemini に渡すメディアデータが大きすぎます。(最大 ${limit} バイト)`);
  }

  const base64Data = buffer.toString('base64');
  const prompt =
    options.prompt?.trim() ||
    'このメディアの内容を要約し、重要なポイントと推奨アクションを日本語で提示してください。';

  const preferred = normalizeModelId(options.model);
  const fallbackList = (options.modelFallbacks || []).map((model) => normalizeModelId(model)).filter(Boolean) as string[];
  const orderedModels = preferred
    ? [preferred, ...fallbackList]
    : [...getDefaultModelOrder(mimeType), ...fallbackList];

  let lastError: any = null;
  for (const candidate of orderedModels) {
    if (!candidate) {
      continue;
    }
    try {
      return await invokeMediaAnalysis({
        model: candidate,
        media: {
          kind: 'inline',
          base64Data,
          mimeType,
        },
        prompt,
      });
    } catch (error: any) {
      lastError = error;
      if (!shouldRetryModel(error)) {
        throw error;
      }
      console.warn(`Gemini モデル ${candidate} でのインライン解析に失敗しました。フォールバックを試します。`, {
        error: error instanceof Error ? error.message : error,
      });
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('利用可能な Gemini モデルが選択されていません。');
}
