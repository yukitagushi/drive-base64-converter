const template = document.getElementById('store-item-template');
const storeListEl = document.getElementById('store-list');
const storeSelector = document.getElementById('store-selector');
const uploadSelect = document.getElementById('upload-store');
const storesStatusEl = document.getElementById('stores-status');
const createStatusEl = document.getElementById('create-status');
const uploadStatusEl = document.getElementById('upload-status');
const detailDisplayEl = document.getElementById('detail-display-name');
const detailGeminiEl = document.getElementById('detail-gemini-name');
const detailDescriptionEl = document.getElementById('detail-description');
const detailCreatedEl = document.getElementById('detail-created-at');
const activityLog = document.getElementById('activity-log');
const heroCountEl = document.getElementById('metric-store-count');
const heroRefreshEl = document.getElementById('metric-last-refresh');
const authIndicator = document.getElementById('auth-indicator');
const sessionStatusEl = document.getElementById('session-status');
const sessionTokenEl = document.getElementById('session-token-state');
const loginButton = document.getElementById('login-button');
const logoutButton = document.getElementById('logout-button');
const manualAuthSection = document.getElementById('manual-auth');
const manualAuthForm = document.getElementById('manual-auth-form');
const manualTokenInput = document.getElementById('manual-token');
const manualClearButton = document.getElementById('manual-clear');
const storeForm = document.getElementById('store-form');
const openCreateDialogButton = document.getElementById('open-create-dialog');
const cancelCreateButton = document.getElementById('cancel-create');
const createDialog = document.getElementById('create-store');
const refreshButton = document.getElementById('refresh-stores');
const uploadForm = document.getElementById('upload-form');
const sidebarYear = document.getElementById('sidebar-year');
const sessionWorkspaceEl = document.getElementById('session-workspace');
const uploadFileInput = document.getElementById('upload-file');

const MANUAL_TOKEN_STORAGE_KEY = 'gemini-manual-token';

class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const state = {
  stores: [],
  selectedStoreId: '',
  manualToken: '',
  lastRefresh: null,
  supabase: null,
  supabaseProvider: 'google'
};

const env = window.__ENV__ || {};

async function initSupabase() {
  const url = env.SUPABASE_URL || '';
  const anonKey = env.SUPABASE_ANON_KEY || '';
  state.supabaseProvider = env.SUPABASE_PROVIDER || 'google';
  if (!url || !anonKey) {
    return null;
  }
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.39.5');
    return createClient(url, anonKey, {
      auth: { persistSession: true }
    });
  } catch (error) {
    console.warn('[ui] failed to load Supabase client', error);
    return null;
  }
}

function loadManualToken() {
  try {
    const raw = localStorage.getItem(MANUAL_TOKEN_STORAGE_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : '';
  } catch (error) {
    console.warn('[ui] failed to parse manual token', error);
    return '';
  }
}

function persistManualToken(token) {
  try {
    if (token) {
      localStorage.setItem(MANUAL_TOKEN_STORAGE_KEY, JSON.stringify(token));
    } else {
      localStorage.removeItem(MANUAL_TOKEN_STORAGE_KEY);
    }
  } catch (error) {
    console.warn('[ui] failed to persist manual token', error);
  }
}

let AUTH = { token: null, workspace: null };

function getActiveToken() {
  return AUTH.token || state.manualToken || null;
}

function setStatus(element, message, status) {
  if (!element) return;
  element.textContent = message || '';
  if (status) {
    element.dataset.state = status;
  } else {
    delete element.dataset.state;
  }
}

function summarisePayload(payload, status) {
  if (!payload || typeof payload !== 'object') {
    return `リクエストに失敗しました (status: ${status}).`;
  }
  const source = payload.source === 'gemini' ? 'Gemini API' : 'API';
  if (typeof payload.error === 'string') {
    return `${source} エラー: ${payload.error}`;
  }
  if (typeof payload.detail === 'string') {
    return `${source} エラー: ${payload.detail}`;
  }
  if (payload.detail && typeof payload.detail === 'object') {
    return `${source} エラー: ${JSON.stringify(payload.detail)}`;
  }
  if (typeof payload.message === 'string') {
    return `${source} エラー: ${payload.message}`;
  }
  return `${source} エラー (status: ${status}).`;
}

function summariseError(error) {
  if (error instanceof HttpError) {
    const body = error.body;
    if (body && typeof body === 'object') {
      return summarisePayload(body, error.status || 500);
    }
    if (typeof body === 'string' && body.trim()) {
      return body.trim();
    }
    return `リクエストに失敗しました (status: ${error.status}).`;
  }
  return error instanceof Error ? error.message : '不明なエラーが発生しました。';
}

function pushActivity(message, status = 'info') {
  if (!activityLog) return;
  const item = document.createElement('li');
  item.dataset.status = status;
  item.textContent = message;
  activityLog.prepend(item);
  while (activityLog.children.length > 40) {
    activityLog.removeChild(activityLog.lastElementChild);
  }
}

function updateStoreDetails() {
  const target = state.stores.find((entry) => entry.id === state.selectedStoreId) || null;
  detailDisplayEl.textContent = target?.displayName || '—';
  detailGeminiEl.textContent = target?.geminiName || '—';
  detailDescriptionEl.textContent = target?.description || '—';
  detailCreatedEl.textContent = target?.createdAt || '—';
}

function renderStoreOptions() {
  if (storeSelector) {
    storeSelector.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '選択してください';
    storeSelector.appendChild(placeholder);
    for (const store of state.stores) {
      const option = document.createElement('option');
      option.value = store.id;
      option.textContent = store.displayName || store.id;
      option.dataset.geminiName = store.geminiName;
      if (store.id === state.selectedStoreId) {
        option.selected = true;
      }
      storeSelector.appendChild(option);
    }
    storeSelector.disabled = state.stores.length === 0;
  }

  if (uploadSelect) {
    uploadSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '選択してください';
    uploadSelect.appendChild(placeholder);
    for (const store of state.stores) {
      const option = document.createElement('option');
      option.value = store.geminiName;
      option.dataset.storeId = store.id;
      option.textContent = store.displayName || store.id;
      uploadSelect.appendChild(option);
    }
    if (state.selectedStoreId) {
      const selectedStore = state.stores.find((entry) => entry.id === state.selectedStoreId);
      if (selectedStore) {
        uploadSelect.value = selectedStore.geminiName;
      }
    }
    uploadSelect.disabled = state.stores.length === 0;
  }
}

function renderStoreList() {
  if (!storeListEl) return;
  storeListEl.innerHTML = '';
  if (state.stores.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'store-item';
    empty.textContent = 'まだストアが登録されていません。';
    empty.setAttribute('data-active', 'false');
    storeListEl.appendChild(empty);
    return;
  }

  for (const store of state.stores) {
    let item;
    if (template?.content) {
      const fragment = template.content.cloneNode(true);
      item = fragment.querySelector('.store-item');
      if (!item) {
        item = document.createElement('li');
        item.className = 'store-item';
      }
      const title = fragment.querySelector('.store-item-title');
      const meta = fragment.querySelector('.store-item-meta');
      if (title) title.textContent = store.displayName || store.id;
      if (meta) meta.textContent = store.geminiName;
      item.dataset.storeId = store.id;
      item.dataset.active = store.id === state.selectedStoreId ? 'true' : 'false';
      storeListEl.appendChild(fragment);
    } else {
      item = document.createElement('li');
      item.className = 'store-item';
      item.dataset.storeId = store.id;
      item.dataset.active = store.id === state.selectedStoreId ? 'true' : 'false';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.innerHTML = `
        <div class="store-item-title">${store.displayName || store.id}</div>
        <div class="store-item-meta">${store.geminiName}</div>
      `;
      storeListEl.appendChild(item);
    }
  }
}

function renderStores() {
  renderStoreOptions();
  renderStoreList();
  updateStoreDetails();
  heroCountEl.textContent = String(state.stores.length);
}

function normalizeStore(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' ? entry.id : '';
  const displayName = typeof entry.displayName === 'string' ? entry.displayName : id;
  const description = typeof entry.description === 'string' ? entry.description : '';
  const geminiName = typeof entry.geminiName === 'string' ? entry.geminiName : '';
  const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : '';
  if (!id || !geminiName) return null;
  return { id, displayName, description, geminiName, createdAt };
}

async function authFetch(url, opt = {}) {
  const options = { ...opt };
  const body = options.body;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers = new Headers(options.headers || {});
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  if (body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getActiveToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  } else {
    headers.delete('Authorization');
  }
  options.headers = headers;
  if (isFormData) {
    options.body = body;
  }
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text();
  if (!response.ok) {
    throw new HttpError(
      typeof payload === 'string' && payload.trim()
        ? payload.trim()
        : payload?.error || payload?.message || 'Request failed',
      response.status,
      payload
    );
  }
  return { data: payload, status: response.status, headers: response.headers };
}

async function fetchStores(showPending = true) {
  if (!getActiveToken()) {
    setStatus(storesStatusEl, '認証情報が必要です。ログインしてください。', 'error');
    state.stores = [];
    state.selectedStoreId = '';
    renderStores();
    return;
  }

  if (showPending) {
    setStatus(storesStatusEl, 'ストア一覧を取得しています…', 'pending');
  }

  try {
    const { data } = await authFetch('/api/file-stores', {
      headers: { 'cache-control': 'no-cache' }
    });
    const stores = Array.isArray(data?.stores) ? data.stores : [];
    const normalized = stores.map(normalizeStore).filter(Boolean);
    normalized.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
    state.stores = normalized;
    if (!state.stores.find((entry) => entry.id === state.selectedStoreId)) {
      state.selectedStoreId = state.stores[0]?.id || '';
    }
    state.lastRefresh = new Date();
    heroRefreshEl.textContent = state.lastRefresh.toLocaleTimeString();
    renderStores();
    if (state.stores.length === 0) {
      setStatus(storesStatusEl, 'まだストアが登録されていません。', 'info');
    } else {
      setStatus(storesStatusEl, `${state.stores.length} 件のストアを取得しました。`, 'success');
    }
    const debugId = typeof data?.debugId === 'string' ? data.debugId : 'local';
    pushActivity(`GET /api/file-stores (${debugId})`, 'info');
  } catch (error) {
    console.error('[ui] failed to fetch stores', error);
    const message = summariseError(error);
    setStatus(storesStatusEl, message, 'error');
    pushActivity(`ストア一覧の取得に失敗しました: ${message}`, 'error');
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      AUTH.token = null;
      updateAuthUI();
    }
  }
}

async function handleCreateStore(event) {
  event.preventDefault();
  if (!storeForm) return;
  const formData = new FormData(storeForm);
  const displayName = (formData.get('displayName') || '').toString().trim();
  const description = (formData.get('description') || '').toString().trim();
  if (!displayName) {
    setStatus(createStatusEl, '表示名を入力してください。', 'error');
    return;
  }
  setStatus(createStatusEl, 'ストアを作成しています…', 'pending');
  const payload = { displayName };
  if (description) {
    payload.description = description;
  }
  try {
    const { data } = await authFetch('/api/file-stores', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const store = normalizeStore(data?.store);
    if (store) {
      state.stores = [store, ...state.stores.filter((entry) => entry.id !== store.id)];
      state.selectedStoreId = store.id;
      renderStores();
    }
    setStatus(createStatusEl, 'ストアを作成しました。', 'success');
    pushActivity(`ストア「${displayName}」を作成しました (${data?.debugId || 'local'})`, 'success');
    storeForm.reset();
    closeCreateDialog();
    await fetchStores(false);
  } catch (error) {
    console.error('[ui] failed to create store', error);
    const message = summariseError(error);
    if (error instanceof HttpError && error.status === 409) {
      setStatus(createStatusEl, '同名のストアが既に存在します。', 'error');
    } else {
      setStatus(createStatusEl, message, 'error');
    }
    pushActivity(`ストアの作成に失敗しました: ${message}`, 'error');
  }
}

async function handleUpload(event) {
  event.preventDefault();
  if (!uploadForm) return;
  const formData = new FormData(uploadForm);
  const storeName = formData.get('fileSearchStoreName');
  if (!storeName || typeof storeName !== 'string' || !storeName.startsWith('fileSearchStores/')) {
    setStatus(uploadStatusEl, 'アップロード先ストアを選択してください。', 'error');
    return;
  }
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    setStatus(uploadStatusEl, 'ファイルを選択してください。', 'error');
    return;
  }
  setStatus(uploadStatusEl, 'アップロード中です…', 'pending');
  try {
    const { data } = await authFetch('/api/documents', {
      method: 'POST',
      body: formData
    });
    setStatus(uploadStatusEl, 'アップロードが完了しました。', 'success');
    pushActivity(`「${file.name}」をアップロードしました (${data?.debugId || 'local'})`, 'success');
    uploadForm.reset();
    if (state.selectedStoreId) {
      const selectedStore = state.stores.find((entry) => entry.id === state.selectedStoreId);
      if (selectedStore) {
        uploadSelect.value = selectedStore.geminiName;
      }
    }
  } catch (error) {
    console.error('[ui] failed to upload document', error);
    const message = summariseError(error);
    setStatus(uploadStatusEl, message, 'error');
    pushActivity(`アップロードに失敗しました: ${message}`, 'error');
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      AUTH.token = null;
      updateAuthUI();
    }
  }
}

function setSelectedStore(storeId) {
  state.selectedStoreId = storeId;
  renderStores();
}

function openCreateDialog() {
  if (!createDialog) return;
  createDialog.hidden = false;
  createDialog.setAttribute('aria-modal', 'true');
  setStatus(createStatusEl, '', undefined);
  setTimeout(() => {
    const firstInput = createDialog.querySelector('input[name="displayName"]');
    if (firstInput instanceof HTMLElement) {
      firstInput.focus();
    }
  }, 16);
}

function closeCreateDialog() {
  if (!createDialog) return;
  createDialog.hidden = true;
  createDialog.removeAttribute('aria-modal');
  setStatus(createStatusEl, '', undefined);
}

function updateAuthUI() {
  const token = getActiveToken();
  const supabaseActive = Boolean(state.supabase);
  const indicatorText = token
    ? '認証済み'
    : supabaseActive
      ? '未認証'
      : '手動トークン未設定';
  if (authIndicator) {
    authIndicator.textContent = indicatorText;
    authIndicator.dataset.state = token ? 'success' : 'idle';
  }
  if (sessionStatusEl) {
    sessionStatusEl.textContent = supabaseActive ? 'Supabase 連携中' : '手動モード';
  }
  if (sessionWorkspaceEl) {
    sessionWorkspaceEl.textContent = supabaseActive
      ? 'Supabase が自動判定'
      : 'サーバが自動的に決定';
  }
  if (sessionTokenEl) {
    sessionTokenEl.textContent = token ? 'Bearer 取得済み' : '未取得';
  }
  if (manualAuthSection) {
    manualAuthSection.hidden = supabaseActive;
  }
  if (loginButton) {
    loginButton.disabled = !supabaseActive;
  }
  if (logoutButton) {
    logoutButton.disabled = !supabaseActive;
  }
  if (storesStatusEl && !token) {
    setStatus(storesStatusEl, '認証情報が必要です。', 'info');
  }
  if (!token) {
    state.stores = [];
    state.selectedStoreId = '';
    state.lastRefresh = null;
    heroRefreshEl.textContent = '—';
    renderStores();
  }
}

async function setSessionFromSupabase() {
  if (!state.supabase) {
    AUTH.token = null;
    updateAuthUI();
    return;
  }
  try {
    const { data } = await state.supabase.auth.getSession();
    const session = data?.session || null;
    AUTH.token = session?.access_token || null;
  } catch (error) {
    console.error('[ui] failed to obtain Supabase session', error);
    AUTH.token = null;
  }
  updateAuthUI();
}

function attachSupabaseListeners() {
  if (!state.supabase) return;
  state.supabase.auth.onAuthStateChange(async () => {
    await setSessionFromSupabase();
    if (getActiveToken()) {
      await fetchStores(true);
    }
  });
}

function handleStoreListClick(event) {
  const target = event.target instanceof HTMLElement ? event.target.closest('[data-store-id]') : null;
  if (!target) return;
  const storeId = target.dataset.storeId || '';
  if (!storeId) return;
  setSelectedStore(storeId);
}

function handleStoreListKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target instanceof HTMLElement ? event.target.closest('[data-store-id]') : null;
  if (!target) return;
  event.preventDefault();
  const storeId = target.dataset.storeId || '';
  if (!storeId) return;
  setSelectedStore(storeId);
}

async function bootstrap() {
  sidebarYear.textContent = new Date().getFullYear().toString();
  state.manualToken = loadManualToken();
  state.supabase = await initSupabase();
  updateAuthUI();
  await setSessionFromSupabase();
  attachSupabaseListeners();
  if (!state.supabase && state.manualToken) {
    manualTokenInput.value = state.manualToken;
  }
  if (getActiveToken()) {
    await fetchStores(true);
  }
}

if (storeListEl) {
  storeListEl.addEventListener('click', handleStoreListClick);
  storeListEl.addEventListener('keydown', handleStoreListKeydown);
}

storeSelector?.addEventListener('change', (event) => {
  const nextId = event.target.value;
  setSelectedStore(nextId || '');
});

uploadSelect?.addEventListener('change', (event) => {
  const geminiName = event.target.value;
  if (!geminiName) {
    state.selectedStoreId = '';
    renderStores();
    return;
  }
  const store = state.stores.find((entry) => entry.geminiName === geminiName);
  if (store) {
    setSelectedStore(store.id);
  }
});

refreshButton?.addEventListener('click', () => {
  void fetchStores(true);
});

storeForm?.addEventListener('submit', handleCreateStore);
uploadForm?.addEventListener('submit', handleUpload);
openCreateDialogButton?.addEventListener('click', openCreateDialog);
cancelCreateButton?.addEventListener('click', closeCreateDialog);

manualAuthForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const token = manualTokenInput?.value.trim() || '';
  state.manualToken = token;
  persistManualToken(token);
  updateAuthUI();
  if (token) {
    void fetchStores(true);
  }
});

manualClearButton?.addEventListener('click', () => {
  state.manualToken = '';
  persistManualToken('');
  if (manualTokenInput) manualTokenInput.value = '';
  updateAuthUI();
  state.stores = [];
  state.selectedStoreId = '';
  renderStores();
});

if (loginButton) {
  loginButton.addEventListener('click', async () => {
    if (!state.supabase) {
      manualTokenInput?.focus();
      return;
    }
    try {
      await state.supabase.auth.signInWithOAuth({
        provider: state.supabaseProvider,
        options: {
          redirectTo: window.location.href
        }
      });
    } catch (error) {
      console.error('[ui] failed to start OAuth flow', error);
      setStatus(storesStatusEl, 'ログインの開始に失敗しました。', 'error');
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener('click', async () => {
    if (!state.supabase) {
      state.manualToken = '';
      persistManualToken('');
      updateAuthUI();
      renderStores();
      return;
    }
    try {
      await state.supabase.auth.signOut();
      AUTH.token = null;
      updateAuthUI();
      state.stores = [];
      state.selectedStoreId = '';
      renderStores();
    } catch (error) {
      console.error('[ui] failed to sign out', error);
      setStatus(storesStatusEl, 'ログアウトに失敗しました。', 'error');
    }
  });
}

if (createDialog) {
  createDialog.addEventListener('click', (event) => {
    if (event.target === createDialog) {
      closeCreateDialog();
    }
  });
}

if (uploadFileInput) {
  uploadFileInput.addEventListener('change', () => {
    if (!uploadFileInput.files || uploadFileInput.files.length === 0) {
      return;
    }
    const file = uploadFileInput.files[0];
    if (file.size > 0 && file.name.endsWith('.zip')) {
      pushActivity('ZIP ファイルを検出しました。Gemini 側で自動展開されます。', 'info');
    }
  });
}

void bootstrap();
