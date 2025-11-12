import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDebugId, GeminiApiError, uploadToFileSearchStore } from '../lib/gemini';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILES_STORE = path.join(DATA_DIR, 'file-store-files.json');

interface ApiRequest extends IncomingMessage {
  method?: string;
}

interface ApiResponse extends ServerResponse {
  status?: (statusCode: number) => ApiResponse;
  json?: (body: unknown) => void;
}

type ErrorSource = 'api' | 'gemini';

interface StoredFileRecord {
  id: string;
  storeName: string;
  originalName: string;
  size: number;
  mimeType: string;
  memo?: string;
  createdAt: string;
  ownerHash: string;
  office?: string;
  geminiFileName?: string;
}

interface StoredPayload {
  files: StoredFileRecord[];
}

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

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

async function readFiles(): Promise<StoredFileRecord[]> {
  try {
    const raw = await fs.readFile(FILES_STORE, 'utf8');
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const parsed = JSON.parse(text) as StoredPayload | StoredFileRecord[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.files)) {
      return parsed.files;
    }
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    console.error('[api/documents] Failed to read file cache', error);
    return [];
  }
}

async function writeFiles(files: StoredFileRecord[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload: StoredPayload = { files };
  await fs.writeFile(FILES_STORE, JSON.stringify(payload, null, 2), 'utf8');
}

async function readRequestBuffer(req: ApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function parseContentDisposition(header: string): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [key, rawValue] = trimmed.split('=');
    if (!rawValue) continue;
    const value = rawValue.replace(/^"|"$/g, '');
    if (key === 'name') {
      result.name = value;
    } else if (key === 'filename') {
      result.filename = value;
    }
  }
  return result;
}

function parseMultipart(buffer: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const boundaryText = `--${boundary}`;
  const allParts = buffer.toString('binary').split(boundaryText);
  for (const rawPart of allParts) {
    const trimmed = rawPart.trim();
    if (!trimmed || trimmed === '--') {
      continue;
    }
    const separatorIndex = trimmed.indexOf('\r\n\r\n');
    if (separatorIndex === -1) {
      continue;
    }
    const headerText = trimmed.slice(0, separatorIndex);
    const dataBinary = trimmed.slice(separatorIndex + 4);
    const headerLines = headerText.split('\r\n');
    const headers = new Map<string, string>();
    for (const line of headerLines) {
      const [key, value] = line.split(':');
      if (!value) continue;
      headers.set(key.toLowerCase(), value.trim());
    }
    const contentDisposition = headers.get('content-disposition');
    if (!contentDisposition) {
      continue;
    }
    const { name, filename } = parseContentDisposition(contentDisposition);
    if (!name) {
      continue;
    }
    const contentType = headers.get('content-type') || undefined;
    // Remove the final CRLF from dataBinary
    const dataString = dataBinary.endsWith('\r\n') ? dataBinary.slice(0, -2) : dataBinary;
    const data = Buffer.from(dataString, 'binary');
    parts.push({ name, filename, contentType, data });
  }
  return parts;
}

function ensureBoundary(req: ApiRequest): string | null {
  const header = req.headers?.['content-type'];
  if (typeof header !== 'string') {
    return null;
  }
  const match = header.match(/boundary=(?:"?)([^";]+)(?:"?)/i);
  return match ? match[1] : null;
}

function respondMethodNotAllowed(res: ApiResponse, debugId: string): void {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Allow', 'POST,OPTIONS');
  }
  respondError(res, 405, 'method_not_allowed', debugId);
}

function toPublicRecord(record: StoredFileRecord): Omit<StoredFileRecord, 'ownerHash'> {
  const { ownerHash: _hash, ...rest } = record;
  return rest;
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
      res.setHeader('Allow', 'POST,OPTIONS');
    }
    jsonResponse(res, 204, { status: 204, source: 'api', debugId });
    return;
  }

  if (req.method !== 'POST') {
    respondMethodNotAllowed(res, debugId);
    return;
  }

  const token = extractBearerToken(req);
  if (!token) {
    respondError(res, 401, 'unauthorized', debugId, 'missing_bearer_token');
    return;
  }
  const ownerHash = hashToken(token);
  const office = extractOffice(req);

  const boundary = ensureBoundary(req);
  if (!boundary) {
    respondError(res, 400, 'invalid_multipart', debugId, 'missing_boundary');
    return;
  }

  const buffer = await readRequestBuffer(req);
  const parts = parseMultipart(buffer, boundary);

  const storePart = parts.find((part) => part.name === 'fileSearchStoreName');
  const memoPart = parts.find((part) => part.name === 'memo');
  const filePart = parts.find((part) => part.name === 'file' && part.filename);

  const storeName = storePart ? storePart.data.toString('utf8').trim() : '';
  if (!storeName || !storeName.startsWith('fileSearchStores/')) {
    respondError(res, 400, 'invalid_store_name', debugId, 'fileSearchStoreName must be fileSearchStores/*');
    return;
  }

  if (!filePart) {
    respondError(res, 400, 'missing_file', debugId, 'file field is required');
    return;
  }

  const fileBuffer = filePart.data;
  if (!fileBuffer?.length) {
    respondError(res, 400, 'empty_file', debugId, 'file must not be empty');
    return;
  }

  const memo = memoPart ? memoPart.data.toString('utf8').trim() : undefined;
  const mimeType = filePart.contentType || 'application/octet-stream';
  const originalName = filePart.filename || 'upload.bin';

  try {
    const geminiResponse = await uploadToFileSearchStore({
      storeName,
      file: fileBuffer,
      fileName: originalName,
      mimeType
    });

    let geminiFileName: string | undefined;
    if (geminiResponse && typeof geminiResponse === 'object') {
      const fileInfo = (geminiResponse as Record<string, unknown>).file;
      if (fileInfo && typeof fileInfo === 'object') {
        const nameValue = (fileInfo as Record<string, unknown>).name;
        if (typeof nameValue === 'string') {
          geminiFileName = nameValue;
        }
      }
    }

    const existing = await readFiles();
    const record: StoredFileRecord = {
      id: crypto.randomUUID(),
      storeName,
      originalName,
      size: fileBuffer.length,
      mimeType,
      memo: memo || undefined,
      createdAt: new Date().toISOString(),
      ownerHash,
      office,
      geminiFileName: typeof geminiFileName === 'string' ? geminiFileName : undefined
    };

    await writeFiles([...existing, record]);

    jsonResponse(res, 201, {
      status: 201,
      source: 'api',
      debugId,
      file: toPublicRecord(record)
    });
  } catch (error) {
    if (error instanceof GeminiApiError) {
      respondError(res, error.status || 502, 'gemini_error', debugId, error.body, 'gemini');
      return;
    }
    console.error('[api/documents] unexpected error', {
      debugId,
      message: String(error)
    });
    respondError(res, 500, 'internal_error', debugId);
  }
}
