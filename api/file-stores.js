const fs = require('node:fs/promises');
const path = require('node:path');
const { createDebugId, createFileSearchStore, GeminiApiError } = require('../lib/gemini.js');

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'file-stores.json');
const MIN_ID_LENGTH = 3;
const MAX_ID_LENGTH = 63;

function jsonResponse(res, statusCode, body) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    res.status(statusCode).json(body);
    return;
  }
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

function respondError(res, statusCode, error, debugId, detail, source = 'api') {
  const body = {
    error,
    status: statusCode,
    source,
    debugId
  };
  if (typeof detail !== 'undefined') {
    body.detail = detail;
  }
  jsonResponse(res, statusCode, body);
}

function sanitizeDisplayName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function sanitizeDescription(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function buildStoreId(displayName) {
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

async function readStores() {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.stores)) {
      return parsed.stores;
    }
    return [];
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    console.error('[api/file-stores] Failed to read store cache', error);
    return [];
  }
}

async function writeStores(stores) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify({ stores }, null, 2), 'utf8');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const chunks = [];
  for await (const chunk of req) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function dumpRequestBody(body) {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const clone = {};
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

function validateStoreId(storeId) {
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

function normalizeForComparison(value) {
  return value.trim().toLowerCase();
}

module.exports = async function handler(req, res) {
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
      res.setHeader('Allow', 'GET,POST');
    }
    jsonResponse(res, 204, { status: 204, source: 'api', debugId });
    return;
  }

  if (req.method === 'GET') {
    const stores = await readStores();
    jsonResponse(res, 200, {
      status: 200,
      source: 'api',
      debugId,
      stores
    });
    return;
  }

  if (req.method !== 'POST') {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Allow', 'GET,POST');
    }
    respondError(res, 405, 'method_not_allowed', debugId);
    return;
  }

  const body = await readJsonBody(req);
  console.log('[api/file-stores] incoming body', dumpRequestBody(body));

  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'fileSearchStoreId')) {
    delete body.fileSearchStoreId;
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

  const duplicate = existing.find(
    (entry) =>
      normalizeForComparison(entry.id) === normalizedId ||
      normalizeForComparison(entry.displayName) === normalizedName
  );

  if (duplicate) {
    respondError(res, 409, 'store_already_exists', debugId, {
      id: duplicate.id,
      displayName: duplicate.displayName
    });
    return;
  }

  try {
    const geminiStore = await createFileSearchStore({
      storeId,
      displayName,
      description
    });

    const record = {
      id: storeId,
      displayName,
      description,
      geminiName: geminiStore.name,
      createdAt: new Date().toISOString()
    };

    await writeStores([...existing, record]);

    jsonResponse(res, 201, {
      status: 201,
      source: 'api',
      debugId,
      store: record
    });
  } catch (error) {
    if (error instanceof GeminiApiError) {
      respondError(res, error.status || 502, 'gemini_error', debugId, error.body, 'gemini');
      return;
    }
    console.error('[api/file-stores] unexpected error', { debugId, message: String(error) });
    respondError(res, 500, 'internal_error', debugId);
  }
};
