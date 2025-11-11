const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { GeminiKnowledgeBase, GeminiFileSearchService } = require('./lib/gemini');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

loadEnvIfNeeded();

const knowledge = new GeminiKnowledgeBase({});
const fileSearch = new GeminiFileSearchService({ apiKey: knowledge.apiKey });

(async () => {
  await knowledge.init();
  fileSearch.setApiKey(knowledge.apiKey);
})();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal_error' }));
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const body = {
      ready: knowledge.isReady,
      error: knowledge.error ? String(knowledge.error.message || knowledge.error) : null,
      documents: knowledge.listDocuments(),
      hasApiKey: Boolean(knowledge.apiKey),
      fileSearchReady: Boolean(fileSearch.apiKey),
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/documents') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ documents: knowledge.listDocuments() }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/documents') {
    const payload = await readJson(req);
    try {
      const entry = await knowledge.addUserDocument({
        title: payload.title,
        content: payload.content,
      });
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ document: entry, documents: knowledge.listDocuments() }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const payload = await readJson(req);
    try {
      const result = await knowledge.chat({
        query: payload.query,
        history: payload.history,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/file-stores') {
    try {
      const stores = await fileSearch.listStores();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ stores }));
    } catch (err) {
      const status = err.message.includes('APIキー') ? 400 : 502;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/file-stores') {
    const payload = await readJson(req);
    try {
      const store = await fileSearch.createStore(payload.displayName || payload.name || '');
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ store }));
    } catch (err) {
      const status = err.message.includes('APIキー') ? 400 : 502;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const storeFilesMatch = url.pathname.match(/^\/api\/file-stores\/([^/]+)\/files$/);
  if (storeFilesMatch) {
    const storeName = decodeURIComponent(storeFilesMatch[1]);
    if (req.method === 'GET') {
      try {
        const files = await fileSearch.listFiles(storeName);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ files }));
      } catch (err) {
        const status = err.message.includes('APIキー') ? 400 : 502;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const payload = await readJson(req);
        const file = await fileSearch.uploadFile({
          storeName,
          fileName: payload.fileName,
          mimeType: payload.mimeType,
          data: payload.data,
          description: payload.description,
        });
        res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ file }));
      } catch (err) {
        const status = err.message.includes('APIキー') ? 400 : 502;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

async function serveStatic(rawPath, res) {
  const safePath = rawPath === '/' ? '/index.html' : rawPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(safePath)));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = getContentType(ext);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      const data = await fs.readFile(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(data);
      return;
    }
    throw err;
  }
}

function getContentType(ext) {
  switch (ext) {
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'text/html; charset=utf-8';
  }
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function loadEnvIfNeeded() {
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    return;
  }

  const envPath = path.join(__dirname, '.env');
  if (!fsSync.existsSync(envPath)) {
    return;
  }

  const contents = fsSync.readFileSync(envPath, 'utf8');
  contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .forEach((line) => {
      const eq = line.indexOf('=');
      if (eq === -1) return;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    });
}
