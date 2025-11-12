import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createDebugId,
  createFileSearchStore,
  GeminiApiError,
  GeminiFileSearchStore
} from '../lib/gemini';

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'file-stores.json');
const MIN_ID_LENGTH = 3;
const MAX_ID_LENGTH = 63;

interface ApiRequest extends IncomingMessage {
  body?: unknown;
  method?: string;
}

interface ApiResponse extends ServerResponse {
  status?: (statusCode: number) => ApiResponse;
  json?: (body: unknown) => void;
}

interface FileStoreRecord {
  id: string;
  displayName: string;
  description?: string;
  geminiName: string;
  createdAt: string;
  ownerHash: string;
  office?: string;
}

interface StoredPayload {
  stores: FileStoreRecord[];
}

type ErrorSource = 'api' | 'gemini';

type RequestBody = {
  displayName?: unknown;
  description?: unknown;
  fileSearchStoreId?: unknown;
};

function jsonResponse(res: ApiResponse, statusCode: number, body: unknown): void {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  if (typeof res.status === 'function') {
    res.status(statusCode);
  } else {
    res.statusCode = statusCode;
  }
  if (typeof res.json === 'function') {
    res.json(body);
    return;
  }
  res.end(JSON.stringify(body));
}

function respondError(
  res: ApiResponse,
  statusCode: number,
  error: string,
  debugId: string,
  detail?: unknown,
  source: ErrorSource = 'api'
): void {
  const payload: Record<string, unknown> = {
    error,
    status: statusCode,
    source,
    debugId
  };
  if (typeof detail !== 'undefined') {
    payload.detail = detail;
  }
  jsonResponse(res, statusCode, payload);
}

function sanitizeDisplayName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

interface StoreIdResult {
  id: string;
  hadInvalid: boolean;
}

function buildStoreId(displayName: string): StoreIdResult {
  const normalized = displayName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  let hadInvalid = false;
  let buffer = '';
  for (const char of normalized) {
    if (/[a-z0-9]/.test(char)) {
      buffer += char;
    } else if (/[\s_-]/.test(char)) {
      buffer += '-';
    } else {
      hadInvalid = true;
    }
  }

  const id = buffer.replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return { id, hadInvalid };
}

function validateStoreId(storeId: string): string | null {
  if (!storeId) {
    return 'missing';
  }
  if (storeId.length < MIN_ID_LENGTH) {
    return 'too_short';
  }
  if (storeId.length > MAX_ID_LENGTH) {
    return 'too_long';
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(storeId)) {
    return 'invalid_chars';
  }
  return null;
}

async function readStores(): Promise<FileStoreRecord[]> {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const parsed = JSON.parse(text) as StoredPayload | FileStoreRecord[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.stores)) {
      return parsed.stores;
    }
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    console.error('[api/file-stores] Failed to read store cache', error);
    return [];
  }
}

async function writeStores(stores: FileStoreRecord[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload: StoredPayload = { stores };
  await fs.writeFile(STORE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

async function readJsonBody(req: ApiRequest): Promise<RequestBody> {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as RequestBody;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody;
  } catch {
    return {};
  }
}

function dumpRequestBody(body: RequestBody): Record<string, unknown> {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'fileSearchStoreId') {
      clone[key] = '[removed]';
      continue;
    }
    if (typeof value === 'string') {
      clone[key] = value.length > 80 ? `${value.slice(0, 77)}...` : value;
    } else {
      clone[key] = value;
    }
  }
  return clone;
}

function normalizeForComparison(value: string): string {
  return value.trim().toLowerCase();
}

function extractBearerToken(req: ApiRequest): string | null {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (typeof header !== 'string') {
    return null;
  }
  const match = header.match(/^Bearer\s+(\S+)/i);
  return match ? match[1] : null;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function extractOffice(req: ApiRequest): string | undefined {
  const header = req.headers?.['x-office'];
  if (typeof header !== 'string') {
    return undefined;
  }
  const trimmed = header.trim();
  return trimmed || undefined;
}

function filterStoresByOwner(
  stores: FileStoreRecord[],
  ownerHash: string,
  office?: string
): FileStoreRecord[] {
  return stores.filter((store) => {
    if (store.ownerHash !== ownerHash) {
      return false;
    }
    if (office && store.office && store.office !== office) {
      return false;
    }
    return true;
  });
}

function toPublicRecord(store: FileStoreRecord): Omit<FileStoreRecord, 'ownerHash'> {
  const { ownerHash: _ignored, ...rest } = store;
  return rest;
}

function respondMethodNotAllowed(res: ApiResponse, debugId: string): void {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Allow', 'GET,POST,OPTIONS');
  }
  respondError(res, 405, 'method_not_allowed', debugId);
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-store');
  }

  const debugId = createDebugId();

  if (!req.method) {
    respondError(res, 400, 'missing_method', debugId);
    return;
  }

  if (req.method === 'OPTIONS') {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Allow', 'GET,POST,OPTIONS');
    }
    jsonResponse(res, 204, { status: 204, source: 'api', debugId });
    return;
  }

  const token = extractBearerToken(req);
  if (!token) {
    respondError(res, 401, 'unauthorized', debugId, 'missing_bearer_token');
    return;
  }
  const ownerHash = hashToken(token);
  const office = extractOffice(req);

  if (req.method === 'GET') {
    const allStores = await readStores();
    const filtered = filterStoresByOwner(allStores, ownerHash, office).map(toPublicRecord);
    jsonResponse(res, 200, {
      status: 200,
      source: 'api',
      debugId,
      stores: filtered
    });
    return;
  }

  if (req.method !== 'POST') {
    respondMethodNotAllowed(res, debugId);
    return;
  }

  const body = await readJsonBody(req);
  console.log('[api/file-stores] incoming body', dumpRequestBody(body));

  if (body && typeof body === 'object' && 'fileSearchStoreId' in body) {
    delete (body as Record<string, unknown>).fileSearchStoreId;
  }

  const displayName = sanitizeDisplayName(body.displayName);
  if (!displayName) {
    respondError(res, 400, 'invalid_display_name', debugId, 'displayName is required');
    return;
  }

  const { id: storeId, hadInvalid } = buildStoreId(displayName);
  if (hadInvalid) {
    respondError(res, 400, 'invalid_store_id', debugId, 'invalid_chars');
    return;
  }

  const idIssue = validateStoreId(storeId);
  if (idIssue) {
    respondError(res, 400, 'invalid_store_id', debugId, idIssue);
    return;
  }

  const description = sanitizeDescription(body.description);

  const existing = await readStores();
  const normalizedId = normalizeForComparison(storeId);
  const normalizedName = normalizeForComparison(displayName);
  const duplicates = filterStoresByOwner(existing, ownerHash, office);

  const duplicate = duplicates.find((entry) => {
    return (
      normalizeForComparison(entry.id) === normalizedId ||
      normalizeForComparison(entry.displayName) === normalizedName
    );
  });

  if (duplicate) {
    respondError(res, 409, 'store_already_exists', debugId, {
      id: duplicate.id,
      displayName: duplicate.displayName
    });
    return;
  }

  try {
    const geminiStore: GeminiFileSearchStore = await createFileSearchStore({
      storeId,
      displayName,
      description
    });

    if (!geminiStore?.name) {
      throw new Error('Gemini response did not include a store name');
    }

    const record: FileStoreRecord = {
      id: storeId,
      displayName,
      description,
      geminiName: geminiStore.name,
      createdAt: new Date().toISOString(),
      ownerHash,
      office
    };

    await writeStores([...existing, record]);

    jsonResponse(res, 201, {
      status: 201,
      source: 'api',
      debugId,
      store: toPublicRecord(record)
    });
  } catch (error) {
    if (error instanceof GeminiApiError) {
      respondError(res, error.status || 502, 'gemini_error', debugId, error.body, 'gemini');
      return;
    }
    console.error('[api/file-stores] unexpected error', {
      debugId,
      message: String(error)
    });
    respondError(res, 500, 'internal_error', debugId);
  }
}
