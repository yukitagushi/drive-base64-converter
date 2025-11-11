const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { GeminiKnowledgeBase, GeminiFileSearchService } = require('./lib/gemini');
const { SupabaseService } = require('./lib/supabase');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

loadEnvIfNeeded();

const knowledge = new GeminiKnowledgeBase({});
const fileSearch = new GeminiFileSearchService({ apiKey: knowledge.apiKey });
const supabase = new SupabaseService();

const sessionState = {
  organizationId: null,
  officeId: null,
  staffId: null,
  threadId: null,
};

(async () => {
  await knowledge.init();
  fileSearch.setApiKey(knowledge.apiKey);
  await initializeSession();
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

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const payload = await buildSessionPayload();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    const payload = await readJson(req);
    const previousStaff = sessionState.staffId;
    updateSessionState(payload);
    if (supabase.isConfigured()) {
      try {
        if (previousStaff && previousStaff !== sessionState.staffId) {
          await supabase.recordAuthEvent({ staffId: previousStaff, type: 'logout' });
        }
        if (sessionState.staffId && previousStaff !== sessionState.staffId) {
          await supabase.recordAuthEvent({ staffId: sessionState.staffId, type: 'login' });
        }
      } catch (err) {
        console.error('Supabase auth event error:', err.message);
      }
    }

    const body = await buildSessionPayload();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/threads') {
    const threads = await supabase
      .listThreads({ officeId: sessionState.officeId })
      .catch((err) => {
        console.error('Supabase thread fetch error:', err.message);
        return [];
      });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      threads,
      session: { ...sessionState },
      supabaseConfigured: supabase.isConfigured(),
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/threads') {
    const payload = await readJson(req);
    const current = updateSessionState(payload.session || {});
    if (!current.officeId || !current.staffId) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '事業所とスタッフを選択してください。' }));
      return;
    }

    try {
      const title = payload.title || generateThreadTitle(payload.query || '');
      const thread = await supabase.ensureThread({
        officeId: current.officeId,
        staffId: current.staffId,
        title,
      });
      sessionState.threadId = thread?.id || null;
      const threads = await supabase
        .listThreads({ officeId: current.officeId })
        .catch(() => []);
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          thread,
          threads,
          session: { ...sessionState },
        })
      );
    } catch (err) {
      console.error('Supabase thread create error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'スレッドの作成に失敗しました' }));
    }
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
      updateSessionState(payload.session || {});
      const activeSession = { ...sessionState };
      let threadInfo = null;

      if (supabase.isConfigured() && activeSession.officeId && activeSession.staffId) {
        if (!activeSession.threadId) {
          threadInfo = await supabase.ensureThread({
            officeId: activeSession.officeId,
            staffId: activeSession.staffId,
            title: generateThreadTitle(payload.query || ''),
          });
          sessionState.threadId = threadInfo?.id || null;
        } else {
          threadInfo = { id: activeSession.threadId };
        }
      }

      const result = await knowledge.chat({
        query: payload.query,
        history: payload.history,
      });

      if (threadInfo?.id && supabase.isConfigured()) {
        try {
          await supabase.recordMessages({
            threadId: threadInfo.id,
            staffId: sessionState.staffId,
            userMessage: payload.query,
            assistantMessage: result.answer,
            context: result.context,
          });
          const threads = await supabase
            .listThreads({ officeId: sessionState.officeId })
            .catch(() => []);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(
            JSON.stringify({
              ...result,
              thread: threads.find((item) => item.id === threadInfo.id) || threadInfo,
              threads,
              session: { ...sessionState, threadId: threadInfo.id },
            })
          );
          return;
        } catch (err) {
          console.error('Supabase chat logging error:', err.message);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          ...result,
          thread: threadInfo,
          session: { ...sessionState },
        })
      );
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/file-stores') {
    try {
      let stores = await fileSearch.listStores();
      try {
        stores = await supabase.decorateStoresForOffice(stores, sessionState.officeId);
      } catch (err) {
        console.error('Supabase store decoration failed:', err.message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          stores,
          session: { ...sessionState },
        })
      );
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
      if (supabase.isConfigured() && sessionState.officeId && sessionState.staffId) {
        try {
          await supabase.recordFileStore({
            organizationId: sessionState.organizationId,
            officeId: sessionState.officeId,
            staffId: sessionState.staffId,
            geminiStoreName: store.name,
            displayName: store.displayName || payload.displayName,
          });
        } catch (err) {
          console.error('Supabase store record error:', err.message);
        }
      }
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
        if (supabase.isConfigured()) {
          try {
            const record = await supabase.findFileStoreRecord(storeName);
            if (record) {
              await supabase.recordFileUpload({
                fileStoreId: record.id,
                staffId: sessionState.staffId,
                geminiFileName: file.name,
                displayName: file.displayName || payload.fileName,
                description: payload.description,
                sizeBytes: file.sizeBytes,
                mimeType: payload.mimeType,
              });
            }
          } catch (err) {
            console.error('Supabase upload log error:', err.message);
          }
        }
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

async function initializeSession() {
  try {
    const hierarchy = await supabase.getHierarchy();
    const firstOrg = hierarchy[0];
    if (firstOrg && !sessionState.organizationId) {
      sessionState.organizationId = firstOrg.id;
    }
    const firstOffice = firstOrg?.offices?.[0];
    if (firstOffice && !sessionState.officeId) {
      sessionState.officeId = firstOffice.id;
    }
    const firstStaff = firstOffice?.staff?.[0];
    if (firstStaff && !sessionState.staffId) {
      sessionState.staffId = firstStaff.id;
    }
  } catch (err) {
    console.error('Supabase session init failed:', err.message);
  }
}

function updateSessionState(partial) {
  if (!partial || typeof partial !== 'object') {
    return { ...sessionState };
  }

  if ('organizationId' in partial) {
    const previousOrganization = sessionState.organizationId;
    sessionState.organizationId = partial.organizationId || null;
    if (previousOrganization && previousOrganization !== sessionState.organizationId) {
      sessionState.officeId = null;
      sessionState.staffId = null;
      sessionState.threadId = null;
    }
  }

  if ('officeId' in partial) {
    const previousOffice = sessionState.officeId;
    sessionState.officeId = partial.officeId || null;
    if (previousOffice && previousOffice !== sessionState.officeId) {
      sessionState.staffId = null;
      sessionState.threadId = null;
    }
  }

  if ('staffId' in partial) {
    const previousStaff = sessionState.staffId;
    sessionState.staffId = partial.staffId || null;
    if (previousStaff && previousStaff !== sessionState.staffId) {
      sessionState.threadId = null;
    }
  }

  if ('threadId' in partial) {
    sessionState.threadId = partial.threadId || null;
  }

  return { ...sessionState };
}

async function buildSessionPayload() {
  let hierarchy = [];
  try {
    hierarchy = await supabase.getHierarchy();
  } catch (err) {
    console.error('Supabase hierarchy error:', err.message);
  }

  if (!sessionState.organizationId && hierarchy[0]) {
    sessionState.organizationId = hierarchy[0].id;
  }

  if (!sessionState.officeId) {
    const org = hierarchy.find((item) => item.id === sessionState.organizationId) || hierarchy[0];
    if (org?.offices?.length) {
      sessionState.officeId = org.offices[0].id;
    }
  }

  if (!sessionState.staffId) {
    const office = hierarchy
      .flatMap((org) => org.offices || [])
      .find((item) => item.id === sessionState.officeId);
    if (office?.staff?.length) {
      sessionState.staffId = office.staff[0].id;
    }
  }

  const currentOffice = hierarchy
    .flatMap((org) => org.offices || [])
    .find((item) => item.id === sessionState.officeId);
  if (currentOffice?.organizationId && sessionState.organizationId !== currentOffice.organizationId) {
    sessionState.organizationId = currentOffice.organizationId;
  }

  const threads = await supabase
    .listThreads({ officeId: sessionState.officeId })
    .catch((err) => {
      console.error('Supabase thread list error:', err.message);
      return [];
    });

  return {
    supabaseConfigured: supabase.isConfigured(),
    hierarchy,
    session: { ...sessionState },
    threads,
  };
}

function generateThreadTitle(text) {
  if (!text) {
    return '新しい質問';
  }
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '新しい質問';
  }
  const snippet = normalized.slice(0, 28);
  return normalized.length > 28 ? `${snippet}…` : snippet;
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
