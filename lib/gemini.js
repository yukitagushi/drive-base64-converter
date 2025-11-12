const crypto = require('node:crypto');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_PROJECT_ID = process.env.GEMINI_PROJECT_ID || '';
const GEMINI_MOCK = process.env.GEMINI_MOCK === '1';

class GeminiApiError extends Error {
  constructor(message, status, body, details) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status;
    this.body = body;
    this.details = details;
  }
}

function maskSecrets(input) {
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

function geminiBaseUrl() {
  if (GEMINI_MOCK) {
    return 'https://mocked-gemini.local/v1beta/fileSearchStores';
  }

  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  if (GEMINI_PROJECT_ID) {
    const encodedProject = encodeURIComponent(GEMINI_PROJECT_ID);
    return `https://generativelanguage.googleapis.com/v1beta/projects/${encodedProject}/fileSearchStores`;
  }

  return 'https://generativelanguage.googleapis.com/v1beta/fileSearchStores';
}

async function createFileSearchStore(params) {
  const { storeId, displayName } = params;

  if (!storeId) {
    throw new Error('storeId is required');
  }

  if (GEMINI_MOCK) {
    return {
      name: `fileSearchStores/${storeId}`,
      displayName,
      description: params.description,
      createTime: new Date().toISOString()
    };
  }

  const endpoint = `${geminiBaseUrl()}?fileSearchStoreId=${encodeURIComponent(storeId)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ displayName })
  });

  const rawText = await response.text();
  const snippet = rawText.slice(0, 512);

  if (!response.ok) {
    const maskedSnippet = maskSecrets(snippet);
    console.error('[gemini] createFileSearchStore failed', {
      status: response.status,
      body: maskedSnippet
    });

    let parsed;
    try {
      parsed = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      parsed = undefined;
    }

    const message = parsed?.error?.message || maskedSnippet || 'Unknown Gemini error';
    throw new GeminiApiError(message, response.status, maskedSnippet, parsed);
  }

  let data;
  try {
    data = rawText ? JSON.parse(rawText) : { name: '' };
  } catch (error) {
    console.error('[gemini] Failed to parse createFileSearchStore response', {
      status: response.status,
      body: maskSecrets(snippet)
    });
    throw new Error('Invalid response from Gemini createFileSearchStore');
  }

  if (!data?.name) {
    throw new Error('Gemini createFileSearchStore response did not include a name');
  }

  return data;
}

function createDebugId() {
  return crypto.randomUUID();
}

module.exports = {
  createFileSearchStore,
  GeminiApiError,
  createDebugId
};
