#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

process.env.GEMINI_MOCK = '1';

const dataDir = path.join(process.cwd(), 'data');
const storeCache = path.join(dataDir, 'file-stores.json');
const fileCache = path.join(dataDir, 'file-store-files.json');

for (const target of [storeCache, fileCache]) {
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
  }
}

const fileStoresModule = require('../.tmp/api/file-stores.js');
const documentsModule = require('../.tmp/api/documents.js');
const fileStoresHandler = typeof fileStoresModule === 'function' ? fileStoresModule : fileStoresModule.default;
const documentsHandler = typeof documentsModule === 'function' ? documentsModule : documentsModule.default;

function createResponse() {
  const headers = {};
  let statusCode = 200;
  let body = '';
  return {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value) {
      statusCode = value;
    },
    headers,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = JSON.stringify(payload);
      this.end(body);
    },
    end(payload) {
      if (typeof payload === 'string') {
        body = payload;
      } else if (payload) {
        body = JSON.stringify(payload);
      }
      this.finished = true;
    },
    finished: false,
    body: () => body
  };
}

async function run(handler, req) {
  const res = createResponse();
  await handler(req, res);
  const payload = res.body();
  return {
    status: res.statusCode,
    headers: res.headers,
    body: payload ? JSON.parse(payload) : null
  };
}

function createJsonRequest(method, url, token, office, payload) {
  const stream = Readable.from([JSON.stringify(payload || {})]);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-office': office
  };
  return stream;
}

function createEmptyRequest(method, url, token, office) {
  const stream = Readable.from([]);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    authorization: `Bearer ${token}`,
    'x-office': office
  };
  return stream;
}

function createMultipartRequest(method, url, token, office, parts) {
  const boundary = '----manual-test-boundary';
  const lines = [];
  for (const part of parts) {
    lines.push(`--${boundary}`);
    const disposition = [`form-data; name="${part.name}"`];
    if (part.filename) {
      disposition.push(`filename="${part.filename}"`);
    }
    lines.push(`Content-Disposition: ${disposition.join('; ')}`);
    if (part.type) {
      lines.push(`Content-Type: ${part.type}`);
    }
    lines.push('');
    lines.push(part.value);
  }
  lines.push(`--${boundary}--`);
  lines.push('');
  const body = lines.join('\r\n');
  const stream = Readable.from([body]);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    authorization: `Bearer ${token}`,
    'x-office': office,
    'content-type': `multipart/form-data; boundary=${boundary}`
  };
  return stream;
}

(async () => {
  const token = 'test-token-1';
  const office = 'tokyo';

  console.log('--- GET (initial) /api/file-stores ---');
  const getInitial = await run(fileStoresHandler, createEmptyRequest('GET', '/api/file-stores', token, office));
  console.log(getInitial);

  const names = ['Alpha Workspace', 'Bravo Docs', 'Charlie Hub'];
  const created = [];
  for (const name of names) {
    console.log(`--- POST create ${name} ---`);
    const response = await run(
      fileStoresHandler,
      createJsonRequest('POST', '/api/file-stores', token, office, { displayName: name })
    );
    console.log(response);
    created.push(response.body?.store);
  }

  console.log('--- POST duplicate (should 409) ---');
  const duplicate = await run(
    fileStoresHandler,
    createJsonRequest('POST', '/api/file-stores', token, office, { displayName: names[0] })
  );
  console.log(duplicate);

  console.log('--- POST invalid (empty) ---');
  const invalid = await run(
    fileStoresHandler,
    createJsonRequest('POST', '/api/file-stores', token, office, { displayName: '' })
  );
  console.log(invalid);

  console.log('--- GET after creations ---');
  const after = await run(fileStoresHandler, createEmptyRequest('GET', '/api/file-stores', token, office));
  console.log(after);

  const targetStore = created[0];
  if (!targetStore?.geminiName) {
    throw new Error('Failed to create store for upload test');
  }

  console.log('--- POST /api/documents upload ---');
  const upload = await run(
    documentsHandler,
    createMultipartRequest('POST', '/api/documents', token, office, [
      { name: 'fileSearchStoreName', value: targetStore.geminiName },
      { name: 'memo', value: 'integration test memo' },
      { name: 'file', value: 'sample content for gemini', filename: 'sample.txt', type: 'text/plain' }
    ])
  );
  console.log(upload);
})();
