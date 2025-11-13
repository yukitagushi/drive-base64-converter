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

const authState = {
  user: null,
  staff: null,
  tokens: null,
};

function normalizeHistory(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => ({
      role: item?.role === 'assistant' || item?.role === 'model' ? 'model' : 'user',
      content: typeof item?.content === 'string' ? item.content : '',
    }))
    .filter((item) => item.content);
}

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
  if (req.method === 'GET' && url.pathname === '/api/auth/state') {
    const payload = await buildAuthPayload();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/login/google') {
    const urlValue = supabase.buildGoogleOAuthUrl({ redirectTo: process.env.SUPABASE_GOOGLE_REDIRECT_URL });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        enabled: Boolean(urlValue),
        url: urlValue,
      })
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login-email') {
    try {
      const payload = await readJson(req);
      const result = await supabase.signInWithPassword({
        email: payload.email,
        password: payload.password,
      });

      if (!result.staff) {
        throw new Error('スタッフ情報が見つかりません。管理者にお問い合わせください。');
      }

      authState.user = {
        id: result.user?.id || result.staff.userId || null,
        email: result.user?.email || payload.email,
        displayName:
          result.user?.user_metadata?.full_name ||
          result.user?.user_metadata?.display_name ||
          result.staff.displayName ||
          payload.email,
      };
      authState.staff = {
        id: result.staff.id,
        email: result.staff.email,
        displayName: result.staff.displayName,
        officeId: result.staff.officeId,
        officeName: result.staff.officeName,
        organizationId: result.staff.organizationId,
        organizationName: result.staff.organizationName,
        role: result.staff.role,
      };
      authState.tokens = result.session
        ? {
            accessToken: result.session.access_token,
            refreshToken: result.session.refresh_token || null,
            expiresIn: result.session.expires_in || null,
            tokenType: result.session.token_type || 'bearer',
          }
        : null;

      syncSessionWithAuth();

      if (supabase.isConfigured() && authState.staff?.id) {
        supabase
          .recordAuthEvent({ staffId: authState.staff.id, type: 'login' })
          .catch((err) => console.error('Supabase auth event error:', err.message));
      }

      const [authPayload, sessionPayload] = await Promise.all([
        buildAuthPayload(),
        buildSessionPayload(),
      ]);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          auth: authPayload,
          session: sessionPayload,
        })
      );
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message || 'ログインに失敗しました。' }));
    }
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/auth/register-email' || url.pathname === '/api/auth/signup')) {
    try {
      const payload = await readJson(req);
      const result = await supabase.signUpWithPassword({
        email: payload.email,
        password: payload.password,
        displayName: payload.displayName,
        organizationName: payload.organizationName,
        officeName: payload.officeName,
      });

      let statusCode = 200;

      if (!result.confirmationRequired && result.staff) {
        authState.user = {
          id: result.user?.id || result.staff.userId || null,
          email: result.user?.email || payload.email,
          displayName:
            result.user?.user_metadata?.full_name ||
            result.user?.user_metadata?.display_name ||
            result.staff.displayName ||
            payload.displayName ||
            payload.email,
        };
        authState.staff = {
          id: result.staff.id,
          email: result.staff.email,
          displayName: result.staff.displayName,
          officeId: result.staff.officeId,
          officeName: result.staff.officeName,
          organizationId: result.staff.organizationId,
          organizationName: result.staff.organizationName,
          role: result.staff.role,
        };
        authState.tokens = result.session
          ? {
              accessToken: result.session.access_token,
              refreshToken: result.session.refresh_token || null,
              expiresIn: result.session.expires_in || null,
              tokenType: result.session.token_type || 'bearer',
            }
          : null;
        syncSessionWithAuth();
        if (supabase.isConfigured() && authState.staff?.id) {
          supabase
            .recordAuthEvent({ staffId: authState.staff.id, type: 'login' })
            .catch((err) => console.error('Supabase auth event error:', err.message));
        }
      } else {
        statusCode = 202;
        authState.user = null;
        authState.staff = null;
        authState.tokens = null;
        await resetSessionAfterLogout();
      }

      const [authPayload, sessionPayload] = await Promise.all([
        buildAuthPayload(),
        buildSessionPayload(),
      ]);

      res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          auth: authPayload,
          session: sessionPayload,
          confirmationRequired: Boolean(result.confirmationRequired),
        })
      );
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.message || '登録に失敗しました。' }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    try {
      if (authState.tokens?.accessToken) {
        await supabase
          .signOut(authState.tokens.accessToken)
          .catch((err) => console.error('Supabase sign-out failed:', err.message));
      }
      if (supabase.isConfigured() && authState.staff?.id) {
        await supabase
          .recordAuthEvent({ staffId: authState.staff.id, type: 'logout' })
          .catch((err) => console.error('Supabase auth event error:', err.message));
      }
    } catch (err) {
      console.error('Logout error:', err.message);
    }

    authState.user = null;
    authState.staff = null;
    authState.tokens = null;
    await resetSessionAfterLogout();

    const [authPayload, sessionPayload] = await Promise.all([
      buildAuthPayload(),
      buildSessionPayload(),
    ]);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        auth: authPayload,
        session: sessionPayload,
      })
    );
    return;
  }
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
    if (supabase.isConfigured() && !authState.staff) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '先にログインしてください。' }));
      return;
    }
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
    if (supabase.isConfigured() && !authState.staff) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'スレッドを閲覧するにはログインが必要です。' }));
      return;
    }
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
    if (supabase.isConfigured() && !authState.staff) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'スレッドを作成するにはログインが必要です。' }));
      return;
    }
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
    if (supabase.isConfigured() && !authState.staff) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'チャットを利用するにはログインしてください。' }));
      return;
    }
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

      const history = normalizeHistory(payload.history);
      const requestedStores = Array.isArray(payload.stores)
        ? payload.stores.map((name) => String(name || '').trim()).filter(Boolean)
        : [];

      let officeStoreNames = [];
      if (supabase.isConfigured() && sessionState.officeId) {
        try {
          const officeStores = await supabase.listOfficeFileStores(sessionState.officeId);
          officeStoreNames = officeStores.map((store) => store.geminiStoreName).filter(Boolean);
        } catch (error) {
          console.error('Supabase office store lookup failed:', error.message);
        }
      }

      const targetStoreNames = requestedStores.length ? requestedStores : officeStoreNames;

      let result = null;
      let source = 'local';

      if (fileSearch?.apiKey && targetStoreNames.length) {
        try {
          const fsResult = await fileSearch.generateAnswer({
            query: payload.query,
            history,
            storeNames: targetStoreNames,
            systemPrompt:
              'アップロード済みのドキュメントを参照しながら、質問に対して事実に基づいた回答を日本語で作成してください。根拠が不十分な場合はその旨を伝えてください。',
          });

          if (fsResult?.answer) {
            source = 'file-search';
            const context = (fsResult.citations || []).map((citation, index) => ({
              id: citation.sourceId || `file-search-${index + 1}`,
              title: citation.sourceTitle || citation.sourceId || `関連ドキュメント ${index + 1}`,
              snippet: citation.chunkText || '',
            }));
            result = {
              answer: fsResult.answer,
              context,
              raw: fsResult.raw,
            };
          }
        } catch (error) {
          console.error('Gemini File Search chat error:', error.message);
        }
      }

      if (!result) {
        const fallback = await knowledge.chat({
          query: payload.query,
          history,
        });
        result = fallback;
        source = 'local';
      }

      if (threadInfo?.id && supabase.isConfigured()) {
        try {
          await supabase.recordMessages({
            threadId: threadInfo.id,
            staffId: sessionState.staffId,
            userMessage: payload.query,
            assistantMessage: result.answer,
            context: {
              source,
              items: result.context,
            },
          });
          const threads = await supabase
            .listThreads({ officeId: sessionState.officeId })
            .catch(() => []);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(
            JSON.stringify({
              ...result,
              source,
              storeNames: targetStoreNames,
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
          source,
          storeNames: targetStoreNames,
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
    if (supabase.isConfigured() && !authState.staff) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'ファイルサーチを利用するにはログインしてください。' }));
      return;
    }
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
    if (supabase.isConfigured() && !authState.staff) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'ストアを作成するにはログインしてください。' }));
      return;
    }
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
    if (supabase.isConfigured() && !authState.staff) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'ファイルにアクセスするにはログインしてください。' }));
      return;
    }
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
        const derivedDescription = file?.analysis?.summary || payload.description;
        const derivedMimeType = file?.analysis?.originalMimeType || file?.mimeType || payload.mimeType;
        if (supabase.isConfigured()) {
          try {
            const record = await supabase.findFileStoreRecord(storeName);
            if (record) {
              await supabase.recordFileUpload({
                fileStoreId: record.id,
                staffId: sessionState.staffId,
                geminiFileName: file.name,
                displayName: file.displayName || payload.fileName,
                description: derivedDescription,
                sizeBytes: file.sizeBytes,
                mimeType: derivedMimeType,
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
    if (supabase.isConfigured() && !authState.staff) {
      return;
    }
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

  if (supabase.isConfigured()) {
    if (!authState.staff) {
      return { ...sessionState };
    }
    sessionState.organizationId = authState.staff.organizationId || null;
    sessionState.officeId = authState.staff.officeId || null;
    sessionState.staffId = authState.staff.id || null;
    if ('threadId' in partial) {
      sessionState.threadId = partial.threadId || null;
    }
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

  let filteredHierarchy = hierarchy;

  if (supabase.isConfigured()) {
    if (authState.staff) {
      filteredHierarchy = hierarchy
        .filter((org) => org.id === authState.staff.organizationId)
        .map((org) => ({
          ...org,
          offices: (org.offices || []).filter((office) => office.id === authState.staff.officeId),
        }));
      sessionState.organizationId = authState.staff.organizationId || null;
      sessionState.officeId = authState.staff.officeId || null;
      sessionState.staffId = authState.staff.id || null;
    } else {
      filteredHierarchy = [];
      sessionState.organizationId = null;
      sessionState.officeId = null;
      sessionState.staffId = null;
      sessionState.threadId = null;
    }
  } else {
    if (!sessionState.organizationId && filteredHierarchy[0]) {
      sessionState.organizationId = filteredHierarchy[0].id;
    }

    if (!sessionState.officeId) {
      const org = filteredHierarchy.find((item) => item.id === sessionState.organizationId) || filteredHierarchy[0];
      if (org?.offices?.length) {
        sessionState.officeId = org.offices[0].id;
      }
    }

    if (!sessionState.staffId) {
      const office = filteredHierarchy
        .flatMap((org) => org.offices || [])
        .find((item) => item.id === sessionState.officeId);
      if (office?.staff?.length) {
        sessionState.staffId = office.staff[0].id;
      }
    }
  }

  const currentOffice = filteredHierarchy
    .flatMap((org) => org.offices || [])
    .find((item) => item.id === sessionState.officeId);
  if (currentOffice?.organizationId && sessionState.organizationId !== currentOffice.organizationId) {
    sessionState.organizationId = currentOffice.organizationId;
  }

  let threads = [];
  if (sessionState.officeId && (!supabase.isConfigured() || authState.staff)) {
    threads = await supabase
      .listThreads({ officeId: sessionState.officeId })
      .catch((err) => {
        console.error('Supabase thread list error:', err.message);
        return [];
      });
  }

  return {
    supabaseConfigured: supabase.isConfigured(),
    hierarchy: filteredHierarchy,
    session: { ...sessionState },
    threads,
  };
}

async function buildAuthPayload() {
  const supabaseConfig = supabase.getBrowserConfig();
  const googleUrl = supabase.buildGoogleOAuthUrl({ redirectTo: process.env.SUPABASE_GOOGLE_REDIRECT_URL });
  const googleEnabled = Boolean(googleUrl && supabaseConfig);
  return {
    authenticated: Boolean(authState.user && authState.staff),
    user: authState.user
      ? {
          id: authState.user.id,
          email: authState.user.email,
          displayName: authState.user.displayName,
        }
      : null,
    staff: authState.staff
      ? {
          id: authState.staff.id,
          email: authState.staff.email,
          displayName: authState.staff.displayName,
          officeId: authState.staff.officeId,
          officeName: authState.staff.officeName,
          organizationId: authState.staff.organizationId,
          organizationName: authState.staff.organizationName,
          role: authState.staff.role,
        }
      : null,
    supabaseConfigured: supabase.isConfigured(),
    authConfigured: supabase.isAuthConfigured(),
    supabase: supabaseConfig,
    providers: {
      google: {
        enabled: googleEnabled,
        url: googleEnabled ? googleUrl : null,
      },
    },
  };
}

function syncSessionWithAuth() {
  if (authState.staff) {
    sessionState.organizationId = authState.staff.organizationId || null;
    sessionState.officeId = authState.staff.officeId || null;
    sessionState.staffId = authState.staff.id || null;
  }
}

async function resetSessionAfterLogout() {
  sessionState.organizationId = null;
  sessionState.officeId = null;
  sessionState.staffId = null;
  sessionState.threadId = null;
  if (!supabase.isConfigured()) {
    await initializeSession();
  }
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
