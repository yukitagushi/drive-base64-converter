import crypto from 'node:crypto';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const UPLOAD_API_ROOT = 'https://generativelanguage.googleapis.com/upload/v1beta';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_PROJECT_ID = process.env.GEMINI_PROJECT_ID || '';
const GEMINI_MOCK = process.env.GEMINI_MOCK === '1';

export interface GeminiFileSearchStore {
  name: string;
  displayName?: string;
  description?: string;
  createTime?: string;
  updateTime?: string;
}

export class GeminiApiError extends Error {
  public readonly status: number;
  public readonly body: string;
  public readonly details: unknown;

  constructor(message: string, status: number, body: string, details?: unknown) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status;
    this.body = body;
    this.details = details;
  }
}

export interface CreateFileSearchStoreParams {
  storeId: string;
  displayName: string;
  description?: string;
}

export interface ImportFileParams {
  storeName: string;
  fileName: string;
}

export interface UploadToFileSearchStoreParams {
  storeName: string;
  file: ArrayBuffer | Uint8Array | Buffer;
  fileName: string;
  mimeType?: string;
}

interface GeminiErrorPayload {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: unknown;
  };
}

function maskSecrets(input: string): string {
  if (!input) {
    return input;
  }
  let masked = input;
  if (GEMINI_API_KEY) {
    const regex = new RegExp(GEMINI_API_KEY.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
    masked = masked.replace(regex, '***');
  }
  return masked;
}

function ensureApiKey(): void {
  if (!GEMINI_API_KEY && !GEMINI_MOCK) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
}

function baseStoreUrl(): string {
  if (GEMINI_MOCK) {
    return 'https://mocked-gemini.local/v1beta/fileSearchStores';
  }
  ensureApiKey();
  if (GEMINI_PROJECT_ID) {
    const encodedProject = encodeURIComponent(GEMINI_PROJECT_ID);
    return `${API_ROOT}/projects/${encodedProject}/fileSearchStores`;
  }
  return `${API_ROOT}/fileSearchStores`;
}

function storeActionUrl(storeName: string, action: string, { upload = false } = {}): string {
  const trimmed = storeName.startsWith('fileSearchStores/') ? storeName : `fileSearchStores/${storeName}`;
  const encodedName = encodeURIComponent(trimmed);
  const base = upload ? UPLOAD_API_ROOT : API_ROOT;
  return `${base}/${encodedName}:${action}`;
}

async function parseGeminiResponse<T>(response: Response, rawText: string): Promise<T> {
  if (!rawText) {
    return {} as T;
  }
  try {
    return JSON.parse(rawText) as T;
  } catch (error) {
    console.error('[gemini] Failed to parse JSON response', {
      status: response.status,
      body: maskSecrets(rawText.slice(0, 512))
    });
    throw new Error('Invalid response from Gemini API');
  }
}

async function handleGeminiResponse<T>(response: Response, context: string): Promise<T> {
  const rawText = await response.text();
  const snippet = rawText.slice(0, 512);

  if (!response.ok) {
    const maskedSnippet = maskSecrets(snippet);
    console.error(`[gemini] ${context} failed`, {
      status: response.status,
      body: maskedSnippet
    });

    let parsed: GeminiErrorPayload | undefined;
    try {
      parsed = rawText ? (JSON.parse(rawText) as GeminiErrorPayload) : undefined;
    } catch {
      parsed = undefined;
    }

    const message = parsed?.error?.message || maskedSnippet || 'Unknown Gemini error';
    throw new GeminiApiError(message, response.status, maskedSnippet, parsed);
  }

  return parseGeminiResponse<T>(response, rawText);
}

export async function createFileSearchStore(
  params: CreateFileSearchStoreParams
): Promise<GeminiFileSearchStore> {
  const { storeId, displayName } = params;

  if (!storeId) {
    throw new Error('storeId is required');
  }
  if (!displayName) {
    throw new Error('displayName is required');
  }

  if (GEMINI_MOCK) {
    return {
      name: `fileSearchStores/${storeId}`,
      displayName,
      description: params.description,
      createTime: new Date().toISOString()
    };
  }

  const endpoint = `${baseStoreUrl()}?fileSearchStoreId=${encodeURIComponent(storeId)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ displayName })
  });

  return handleGeminiResponse<GeminiFileSearchStore>(response, 'createFileSearchStore');
}

export async function importFileToFileSearchStore(
  params: ImportFileParams
): Promise<Record<string, unknown>> {
  const { storeName, fileName } = params;
  if (!storeName || !fileName) {
    throw new Error('storeName and fileName are required');
  }

  if (GEMINI_MOCK) {
    return {
      operation: 'mock-import',
      storeName,
      fileName,
      createTime: new Date().toISOString()
    };
  }

  const endpoint = storeActionUrl(storeName, 'importFile');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ fileName })
  });

  return handleGeminiResponse<Record<string, unknown>>(response, 'importFileToFileSearchStore');
}

export async function uploadToFileSearchStore(
  params: UploadToFileSearchStoreParams
): Promise<Record<string, unknown>> {
  const { storeName, file, fileName, mimeType } = params;
  if (!storeName || !file || !fileName) {
    throw new Error('storeName, file and fileName are required');
  }

  if (GEMINI_MOCK) {
    return {
      operation: 'mock-upload',
      storeName,
      fileName,
      size: file instanceof Uint8Array ? file.byteLength : (file as ArrayBuffer).byteLength || 0,
      createTime: new Date().toISOString()
    };
  }

  const endpoint = storeActionUrl(storeName, 'uploadToFileSearchStore', { upload: true });
  const buffer = file instanceof Uint8Array ? file : Buffer.from(file);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'content-type': mimeType || 'application/octet-stream',
      'x-goog-upload-file-name': encodeURIComponent(fileName),
      'x-goog-upload-protocol': 'raw'
    },
    body: buffer as unknown as BodyInit
  });

  return handleGeminiResponse<Record<string, unknown>>(response, 'uploadToFileSearchStore');
}

export function createDebugId(): string {
  return crypto.randomUUID();
}
