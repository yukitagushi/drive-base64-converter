const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com';
const GEMINI_API_BASE = `${GEMINI_API_ROOT}/v1beta`;
const GEMINI_UPLOAD_BASE = `${GEMINI_API_ROOT}/upload/v1beta`;
const GEMINI_CHAT_BASE = `${GEMINI_API_ROOT}/v1`;

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
  uri?: string;
}

export interface GeminiStoreResult {
  storeName: string;
  displayName: string;
  createTime: string | null;
  updateTime: string | null;
}

export interface GeminiFileUploadResult {
  geminiFileName: string;
  geminiFileUri: string | null;
  displayName: string;
  mimeType: string | null;
  sizeBytes: number;
  createTime: string | null;
  updateTime: string | null;
  /** Indicates whether the file was registered in Gemini File Search. */
  registered: boolean;
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

export interface GeminiChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface GeminiChatCandidate {
  text: string;
  finishReason: string | null;
  index: number | null;
}

export interface GeminiChatResult {
  text: string;
  candidates: GeminiChatCandidate[];
  usage?: Record<string, any> | null;
  raw?: any;
}

export interface GeminiChatFileSearchOptions {
  storeName: string;
  maxChunks?: number;
  dynamicThreshold?: number;
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
    geminiFileUri: (entry as any)?.uri || null,
    displayName: entry.displayName || deriveDisplayName(entry.name),
    mimeType: entry.mimeType || null,
    sizeBytes: typeof entry.sizeBytes === 'string' ? Number(entry.sizeBytes) : Number(entry.sizeBytes || 0),
    createTime: entry.createTime || null,
    updateTime: entry.updateTime || null,
    registered: true,
  };
}

function deriveDisplayName(name?: string): string {
  if (!name) return '';
  const parts = String(name).split('/');
  return parts[parts.length - 1] || name;
}

function sanitizeUploadMimeType(value?: string | null): string {
  if (!value) {
    return 'application/octet-stream';
  }
  const primary = String(value).split(';')[0]?.trim();
  return primary || 'application/octet-stream';
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

  if (trimmed.startsWith('stores/')) {
    const slug = trimmed.slice('stores/'.length);
    const sanitized = slugify(slug) || slug;
    return `fileSearchStores/${sanitized}`;
  }

  if (trimmed.startsWith('projects/')) {
    const match = trimmed.match(/fileSearchStores\/(.+)$/);
    if (match?.[1]) {
      return `fileSearchStores/${match[1]}`;
    }
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

const PREFERRED_MULTIMODAL_MODELS = [
  // Restrict to names that ListModels for /v1 has actually reported.
  'models/gemini-1.5-flash',
  'models/gemini-1.5-pro',
  'models/gemini-1.0-pro-vision',
];

const PREFERRED_TEXT_MODELS = [
  'models/gemini-1.5-pro',
  'models/gemini-1.0-pro',
  'models/chat-bison-001',
  'models/text-bison-001',
];

const GEMINI_MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedGenerateContentModels: string[] | null = null;
let cachedGenerateContentModelsFetchedAt = 0;

export async function debugListGeminiModels(options: { pageSize?: number; pageToken?: string } = {}): Promise<void> {
  try {
    ensureGeminiEnvironment({ requireApiKey: true, requireProject: false, requireLocation: false });
  } catch (error) {
    console.error('Gemini ListModels 呼び出しの前提チェックに失敗しました。', error);
    return;
  }

  try {
    const params = new URLSearchParams();
    if (options.pageSize) {
      params.set('pageSize', String(Math.max(1, Math.min(100, options.pageSize))));
    }
    if (options.pageToken) {
      params.set('pageToken', options.pageToken);
    }

    const url = `${GEMINI_CHAT_BASE}/models${params.size ? `?${params.toString()}` : ''}`;
    const response = await geminiFetch(url, { method: 'GET' });
    const raw = await response.text();
    const preview = raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw;
    console.info('Gemini ListModels result preview:', preview);

    try {
      const payload = JSON.parse(raw);
      if (Array.isArray(payload?.models)) {
        const names = payload.models
          .map((model: any) => (typeof model?.name === 'string' ? model.name : null))
          .filter(Boolean);
        console.info('Gemini ListModels names:', names);
      }
    } catch (parseError) {
      console.warn('Gemini ListModels レスポンスの JSON 解析に失敗しました。', parseError);
    }
  } catch (error) {
    console.error('Gemini ListModels 呼び出しに失敗しました。', error);
  }
}

async function fetchGenerateContentModelNames(forceRefresh = false): Promise<string[]> {
  const now = Date.now();
  if (!forceRefresh && cachedGenerateContentModels && now - cachedGenerateContentModelsFetchedAt < GEMINI_MODEL_CACHE_TTL_MS) {
    return cachedGenerateContentModels;
  }

  const discovered: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams();
    params.set('pageSize', '100');
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const url = `${GEMINI_CHAT_BASE}/models${params.size ? `?${params.toString()}` : ''}`;
    const response = await geminiFetch(url, { method: 'GET' });
    const raw = await response.text();
    const payload = parsePayload(raw);

    if (!response.ok) {
      const message = extractErrorMessage(payload, 'Gemini ListModels に失敗しました。');
      throw new GeminiApiError(message, { status: response.status, body: payload });
    }

    const models = Array.isArray(payload?.models) ? payload.models : [];
    for (const entry of models) {
      const name = typeof entry?.name === 'string' ? entry.name : null;
      if (!name) {
        continue;
      }
      const supported = Array.isArray(entry?.supportedGenerationMethods)
        ? entry.supportedGenerationMethods.map((method: any) => String(method).toLowerCase())
        : [];
      const supportsGenerateContent = supported.length === 0 || supported.includes('generatecontent');
      if (supportsGenerateContent && !discovered.includes(name)) {
        discovered.push(name);
      }
    }

    pageToken = typeof payload?.nextPageToken === 'string' && payload.nextPageToken ? payload.nextPageToken : undefined;
  } while (pageToken);

  cachedGenerateContentModels = discovered;
  cachedGenerateContentModelsFetchedAt = now;
  console.info('fetchGenerateContentModelNames available:', cachedGenerateContentModels);
  return discovered;
}

export async function createFileStore(displayName: string): Promise<GeminiStoreResult> {
  const label = typeof displayName === 'string' ? displayName.trim() : '';
  const body: Record<string, string> = {};
  if (label) {
    body.displayName = label;
  }

  ensureGeminiEnvironment({ requireProject: false, requireLocation: false });

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

  const sanitizedMimeType = sanitizeUploadMimeType(options.mimeType);
  const storeResource = ensureStoreResourceName(options.storeName, options.displayName);
  const normalizedStoreResource = storeResource.replace(/\/+$/, '');
  const uploadResourcePath = normalizedStoreResource;

  const metadataPayload = {
    displayName: options.displayName || 'document',
    mimeType: sanitizedMimeType,
  };
  // NOTE: Gemini's upload metadata currently rejects unknown fields such as
  // "description", so we persist descriptions only in Supabase instead of the
  // API payload to avoid 400 Invalid JSON errors.

  const fileBytes = Buffer.isBuffer(options.fileBuffer)
    ? new Uint8Array(options.fileBuffer)
    : options.fileBuffer;

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadataPayload)], { type: 'application/json; charset=utf-8' }),
    'metadata.json'
  );
  form.append(
    'file',
    new Blob([fileBytes], { type: sanitizedMimeType }),
    options.displayName || 'document'
  );

  const apiKey = ensureApiKey();
  const uploadUrl = `${GEMINI_UPLOAD_BASE}/${encodePath(
    uploadResourcePath
  )}:uploadToFileSearchStore?uploadType=multipart&key=${encodeURIComponent(apiKey)}`;
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
    const payloadError = uploadPayload?.payload?.error || uploadPayload?.error || null;
    console.error('Gemini file upload error', {
      status: uploadResponse.status,
      body: typeof uploadText === 'string' ? uploadText.slice(0, 512) : uploadText,
      debugId,
      storeResource: normalizedStoreResource,
      uploadUrl,
      payloadError,
    });

    if (uploadResponse.status >= 500) {
      console.error('Gemini file upload encountered a server-side error. Continuing without File Search registration.', {
        status: uploadResponse.status,
        storeResource: normalizedStoreResource,
        uploadUrl,
      });
      return {
        geminiFileName: '',
        geminiFileUri: null,
        displayName: options.displayName || 'document',
        mimeType: options.mimeType || null,
        sizeBytes: options.fileBuffer.length,
        createTime: null,
        updateTime: null,
        registered: false,
      };
    }

    const enrichedMessage =
      uploadResponse.status === 404
        ? `Gemini File Search ストア (${normalizedStoreResource}) が見つかりません。`
        : message;
    throw new GeminiApiError(enrichedMessage, {
      status: uploadResponse.status,
      debugId,
      body: {
        payload: uploadPayload,
        storeResource: normalizedStoreResource,
        uploadUrl,
      },
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
    uri: result.geminiFileUri,
    displayName: result.displayName,
    sizeBytes: result.sizeBytes,
    store: normalizedStoreResource,
    uploadUrl,
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

function buildChatRequestContents(messages: GeminiChatMessage[]) {
  const contents: any[] = [];

  for (const entry of messages || []) {
    if (!entry || typeof entry.content !== 'string') {
      continue;
    }
    const trimmed = entry.content.trim();
    if (!trimmed) {
      continue;
    }

    if (entry.role === 'system') {
      // system メッセージは generateChatResponse 側で最初の user に統合済み
      continue;
    }

    const role = entry.role === 'assistant' ? 'model' : 'user';
    contents.push({
      role,
      parts: [{ text: trimmed }],
    });
  }

  return contents;
}

function buildChatPayload({
  contents,
  fileSearch,
  generationConfig,
}: {
  contents: any[];
  fileSearch?: GeminiChatFileSearchOptions | null;
  generationConfig?: Record<string, number>;
}) {
  const payload: Record<string, any> = {
    contents,
  };

  if (fileSearch && fileSearch.storeName) {
    payload.tools = [
      {
        file_search: {
          file_search_store_names: [fileSearch.storeName],
        },
      },
    ];

    const fileSearchConfig: Record<string, any> = {};
    if (typeof fileSearch.maxChunks === 'number') {
      fileSearchConfig.max_chunks = fileSearch.maxChunks;
    }
    if (typeof fileSearch.dynamicThreshold === 'number') {
      fileSearchConfig.dynamic_retrieval_config = {
        mode: 'MODE_DYNAMIC',
        dynamic_threshold: fileSearch.dynamicThreshold,
      };
    }

    if (Object.keys(fileSearchConfig).length > 0) {
      payload.tool_config = { file_search: fileSearchConfig };
    }
  }

  if (generationConfig && Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  return payload;
}

export async function generateChatResponse(options: {
  messages: GeminiChatMessage[];
  model?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  systemInstruction?: string;
  fileSearch?: GeminiChatFileSearchOptions | null;
}): Promise<GeminiChatResult> {
  if (!options || !Array.isArray(options.messages) || options.messages.length === 0) {
    throw new Error('Gemini チャットにはメッセージが必要です。');
  }

  ensureGeminiEnvironment({ requireProject: false, requireLocation: false });

  const baseMessages = Array.isArray(options.messages) ? [...options.messages] : [];

  const instruction = options.systemInstruction?.trim();
  if (instruction) {
    const firstUserIndex = baseMessages.findIndex((message) => message?.role === 'user' && typeof message.content === 'string');
    if (firstUserIndex >= 0) {
      const existing = baseMessages[firstUserIndex]?.content || '';
      baseMessages[firstUserIndex] = {
        ...baseMessages[firstUserIndex],
        content: `${instruction}\n\n${existing}`.trim(),
      };
    } else {
      baseMessages.unshift({
        role: 'user',
        content: instruction,
      });
    }
  }

  const contents = buildChatRequestContents(baseMessages);
  if (!contents.length) {
    throw new Error('Gemini チャットにはユーザーまたはアシスタントのメッセージが必要です。');
  }

  const generationConfig: Record<string, number> = {};
  if (typeof options.temperature === 'number') {
    generationConfig.temperature = options.temperature;
  }
  if (typeof options.topP === 'number') {
    generationConfig.topP = options.topP;
  }
  if (typeof options.topK === 'number') {
    generationConfig.topK = options.topK;
  }
  if (typeof options.maxOutputTokens === 'number') {
    generationConfig.maxOutputTokens = options.maxOutputTokens;
  }
  const payload = buildChatPayload({
    contents,
    fileSearch: options.fileSearch,
    generationConfig,
  });

  if (process.env.NODE_ENV !== 'production') {
    try {
      const payloadPreview = JSON.stringify(payload);
      console.debug('Gemini chat payload preview:', payloadPreview.length > 2000 ? `${payloadPreview.slice(0, 2000)}…` : payloadPreview);
    } catch (payloadError) {
      console.debug('Gemini chat payload serialization failed:', payloadError);
    }
  }

  const preferredModel = normalizeModelId(options.model);
  const defaultModels = await getDefaultModelOrder();
  const orderedModels = (preferredModel
    ? [preferredModel, ...defaultModels]
    : [...defaultModels]
  ).filter((model, index, arr) => model && arr.indexOf(model) === index) as string[];

  if (!orderedModels.length) {
    throw new Error('利用可能な Gemini チャットモデルが選択されていません。');
  }

  const bodyJson = JSON.stringify(payload);
  let lastError: any = null;

  for (const model of orderedModels) {
    const url = `${GEMINI_CHAT_BASE}/${encodePath(model)}:generateContent`;
    const response = await geminiFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: bodyJson,
    });

    const raw = await response.text();
    const payload = parsePayload(raw);

    if (!response.ok) {
      const message = extractErrorMessage(payload, 'Gemini チャット生成に失敗しました。');
      const debugId = extractDebugId(payload);
      const geminiError = new GeminiApiError(message, {
        status: response.status,
        debugId,
        body: payload,
      });
      console.error('Gemini chat generateContent error', {
        status: response.status,
        body: typeof raw === 'string' ? raw.slice(0, 512) : raw,
        debugId,
        model,
      });

      if (!shouldRetryChatModel(geminiError)) {
        throw geminiError;
      }

      lastError = geminiError;
      console.warn(`Gemini モデル ${model} でのチャット生成に失敗しました。フォールバックを試します。`, {
        status: geminiError.status,
        message: geminiError.message,
      });
      continue;
    }

    const candidates = Array.isArray((payload as any)?.candidates) ? (payload as any).candidates : [];
    const normalizedCandidates: GeminiChatCandidate[] = candidates.map((candidate: any, index: number) => {
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
        index: typeof candidate?.index === 'number' ? candidate.index : index,
      };
    });

    const primary = normalizedCandidates.find((candidate) => candidate.text) || null;

    return {
      text: primary?.text || '',
      candidates: normalizedCandidates,
      usage: (payload as any)?.usageMetadata || (payload as any)?.usage_metadata || null,
      raw: payload,
    };
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('利用可能な Gemini チャットモデルが選択されていません。');
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
      fileUri: string;
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
    const fileData: Record<string, string> = { fileUri: media.fileUri };
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

async function getDefaultModelOrder(mimeType?: string | null): Promise<string[]> {
  const available = await fetchGenerateContentModelNames();
  if (!available.length) {
    throw new Error('ListModels から利用可能な Gemini モデルを取得できませんでした。');
  }

  const availableSet = new Set(available);
  const normalized = mimeType?.split(';')[0]?.trim().toLowerCase() || '';
  const preferred = normalized.startsWith('image/') || normalized.startsWith('video/') || normalized.startsWith('audio/')
    ? PREFERRED_MULTIMODAL_MODELS
    : PREFERRED_TEXT_MODELS;

  const ordered: string[] = [];
  for (const name of preferred) {
    if (availableSet.has(name) && !ordered.includes(name)) {
      ordered.push(name);
    }
  }

  for (const name of available) {
    if (!ordered.includes(name)) {
      ordered.push(name);
    }
  }

  return ordered;
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

function shouldRetryChatModel(error: any): boolean {
  if (!(error instanceof GeminiApiError)) {
    return false;
  }
  if (!error.status) {
    return true;
  }
  return error.status === 404 || error.status === 429 || error.status >= 500;
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
  geminiFileUri?: string | null;
  prompt?: string;
  mimeType?: string;
  model?: string;
  modelFallbacks?: string[];
}): Promise<GeminiMediaAnalysisResult> {
  const fileName = String(options.geminiFileName || '').trim();
  if (!fileName) {
    throw new Error('Gemini に渡すファイル名が指定されていません。');
  }

  const fileUri = String(options.geminiFileUri || '').trim() || fileName;

  const prompt =
    options.prompt?.trim() ||
    'このメディアの内容を要約し、重要なポイントと推奨アクションを日本語で提示してください。';

  const preferred = normalizeModelId(options.model);
  const fallbackList = (options.modelFallbacks || []).map((model) => normalizeModelId(model)).filter(Boolean) as string[];
  const orderedModels = preferred
    ? [preferred, ...fallbackList]
    : [...(await getDefaultModelOrder(options.mimeType)), ...fallbackList];

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
          fileUri,
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

  let buffer = toBuffer(options.buffer);
  if (!buffer.length) {
    throw new Error('Gemini に渡すメディアデータが空です。');
  }

  const limit = typeof options.maxBytes === 'number' ? options.maxBytes : INLINE_MEDIA_MAX_BYTES;
  if (buffer.length > limit) {
    console.warn('analyzeInlineMediaWithGemini: media truncated for analysis', {
      mimeType,
      originalBytes: buffer.length,
      truncatedTo: limit,
    });
    buffer = buffer.subarray(0, limit);
  }

  const base64Data = buffer.toString('base64');
  const prompt =
    options.prompt?.trim() ||
    'このメディアの内容を要約し、重要なポイントと推奨アクションを日本語で提示してください。';

  const preferred = normalizeModelId(options.model);
  const fallbackList = (options.modelFallbacks || []).map((model) => normalizeModelId(model)).filter(Boolean) as string[];
  const orderedModels = preferred
    ? [preferred, ...fallbackList]
    : [...(await getDefaultModelOrder(mimeType)), ...fallbackList];

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
