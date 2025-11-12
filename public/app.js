const STORAGE_KEY = 'gemini-file-search-auth';

const state = {
  token: '',
  office: '',
  stores: [],
  selectedStoreId: ''
};

function loadCredentials() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { token: '', office: '' };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        token: typeof parsed.token === 'string' ? parsed.token : '',
        office: typeof parsed.office === 'string' ? parsed.office : ''
      };
    }
  } catch (error) {
    console.warn('[ui] failed to read credentials', error);
  }
  return { token: '', office: '' };
}

function persistCredentials(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('[ui] failed to persist credentials', error);
  }
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

function updateAuthStatus(message, status) {
  const el = document.getElementById('auth-status');
  setStatus(el, message, status);
}

function pushActivity(message, status = 'info') {
  const log = document.getElementById('activity-log');
  if (!log) return;
  const item = document.createElement('li');
  item.dataset.status = status;
  item.textContent = message;
  log.prepend(item);
  while (log.children.length > 30) {
    log.removeChild(log.lastElementChild);
  }
}

function updateHeroStoreCount() {
  const countEl = document.getElementById('hero-store-count');
  if (!countEl) return;
  countEl.textContent = `${state.stores.length} 件`;
}

function summariseError(payload, status) {
  if (!payload) {
    return `リクエストに失敗しました (status: ${status}).`;
  }
  const source = payload.source === 'gemini' ? 'Gemini API' : 'API';
  if (typeof payload.error === 'string') {
    return `${source} エラー: ${payload.error}`;
  }
  if (typeof payload.message === 'string') {
    return `${source} エラー: ${payload.message}`;
  }
  if (payload.error && typeof payload.error.message === 'string') {
    return `${source} エラー: ${payload.error.message}`;
  }
  return `${source} エラー (status: ${status}).`;
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

function authFetch(input, init = {}) {
  const options = { ...init };
  const body = options.body;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers = new Headers(options.headers || {});
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  if (body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (state.token) {
    headers.set('Authorization', `Bearer ${state.token}`);
  } else {
    headers.delete('Authorization');
  }
  if (state.office) {
    headers.set('X-Office', state.office);
  } else {
    headers.delete('X-Office');
  }
  options.headers = headers;
  if (isFormData) {
    options.body = body;
  }
  return fetch(input, options);
}

function updateStoreDetails() {
  const displayEl = document.getElementById('detail-display-name');
  const geminiEl = document.getElementById('detail-gemini-name');
  const descriptionEl = document.getElementById('detail-description');
  const createdEl = document.getElementById('detail-created-at');
  const target = state.stores.find((entry) => entry.id === state.selectedStoreId) || null;
  displayEl.textContent = target?.displayName || '—';
  geminiEl.textContent = target?.geminiName || '—';
  descriptionEl.textContent = target?.description || '—';
  createdEl.textContent = target?.createdAt || '—';
}

function updateStoreList() {
  const list = document.getElementById('store-list');
  if (!list) return;
  list.innerHTML = '';
  if (state.stores.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'まだストアが登録されていません。';
    list.appendChild(empty);
    return;
  }
  for (const store of state.stores) {
    const item = document.createElement('li');
    item.dataset.storeId = store.id;
    if (store.id === state.selectedStoreId) {
      item.dataset.active = 'true';
    }
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    const name = document.createElement('span');
    name.textContent = store.displayName || store.id;
    name.className = 'store-item-name';
    const meta = document.createElement('span');
    meta.textContent = store.geminiName;
    meta.className = 'store-item-meta';
    item.append(name, meta);
    list.appendChild(item);
  }
}

function updateStoreSelects() {
  const select = document.getElementById('store-select');
  const uploadSelect = document.getElementById('upload-store-select');
  const placeholderText = 'ストアを選択';

  if (select) {
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = placeholderText;
    select.appendChild(placeholder);
    for (const store of state.stores) {
      const option = document.createElement('option');
      option.value = store.id;
      option.textContent = store.displayName || store.id;
      option.dataset.geminiName = store.geminiName;
      if (store.id === state.selectedStoreId) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    select.value = state.selectedStoreId || '';
  }

  if (uploadSelect) {
    uploadSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = placeholderText;
    uploadSelect.appendChild(placeholder);
    for (const store of state.stores) {
      const option = document.createElement('option');
      option.value = store.id;
      option.textContent = store.displayName || store.id;
      option.dataset.geminiName = store.geminiName;
      if (store.id === state.selectedStoreId) {
        option.selected = true;
      }
      uploadSelect.appendChild(option);
    }
    uploadSelect.disabled = state.stores.length === 0;
    if (state.stores.length > 0) {
      uploadSelect.value = state.selectedStoreId || state.stores[0].id;
    }
  }
}

function renderStores() {
  updateStoreSelects();
  updateStoreList();
  updateStoreDetails();
  updateHeroStoreCount();
}

async function loadStores(showPending = true) {
  const statusEl = document.getElementById('store-status');
  if (!state.token) {
    setStatus(statusEl, 'Bearer トークンを設定してください。', 'error');
    state.stores = [];
    state.selectedStoreId = '';
    renderStores();
    return;
  }

  if (showPending) {
    setStatus(statusEl, 'ストア一覧を取得しています…', 'pending');
  }

  try {
    const res = await authFetch('/api/file-stores', {
      headers: { 'cache-control': 'no-cache' }
    });
    const payload = await res.json().catch(() => null);

    if (res.status === 401 || res.status === 403) {
      setStatus(statusEl, '認証情報を確認してください。', 'error');
      updateAuthStatus('未接続', 'error');
      state.stores = [];
      state.selectedStoreId = '';
      renderStores();
      return;
    }

    if (!res.ok) {
      const message = summariseError(payload, res.status);
      setStatus(statusEl, message, 'error');
      return;
    }

    const stores = Array.isArray(payload?.stores) ? payload.stores : [];
    const normalized = stores.map(normalizeStore).filter(Boolean);
    normalized.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
    state.stores = normalized;
    if (!state.stores.find((entry) => entry.id === state.selectedStoreId)) {
      state.selectedStoreId = state.stores[0]?.id || '';
    }
    renderStores();
    if (state.stores.length === 0) {
      setStatus(statusEl, 'まだストアがありません。', 'idle');
    } else {
      setStatus(statusEl, 'ストア一覧を更新しました。', 'success');
    }
    pushActivity('ストア一覧を取得しました。', 'info');
  } catch (error) {
    console.error('[ui] failed to load stores', error);
    setStatus(statusEl, 'ストア一覧の取得に失敗しました。', 'error');
  }
}

async function createStore(form) {
  const statusEl = document.getElementById('store-status');
  const formData = new FormData(form);
  const displayName = (formData.get('displayName') || '').toString().trim();
  const description = (formData.get('description') || '').toString().trim();

  if (!displayName) {
    setStatus(statusEl, '表示名を入力してください。', 'error');
    return;
  }

  setStatus(statusEl, 'ストアを作成しています…', 'pending');

  try {
    const body = { displayName };
    if (description) {
      body.description = description;
    }
    const res = await authFetch('/api/file-stores', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    const payload = await res.json().catch(() => null);

    if (res.status === 401 || res.status === 403) {
      setStatus(statusEl, '認証情報を確認してください。', 'error');
      updateAuthStatus('未接続', 'error');
      return;
    }

    if (res.status === 409) {
      setStatus(statusEl, '同じ表示名のストアが既に存在します。', 'error');
      return;
    }

    if (!res.ok) {
      const message = summariseError(payload, res.status);
      setStatus(statusEl, message, 'error');
      return;
    }

    setStatus(statusEl, 'ストアを作成しました。', 'success');
    pushActivity(`ストア「${displayName}」を作成しました。`, 'success');
    form.reset();
    await loadStores(false);
  } catch (error) {
    console.error('[ui] failed to create store', error);
    setStatus(statusEl, 'ストアの作成に失敗しました。', 'error');
  }
}

async function uploadDocument(form) {
  const statusEl = document.getElementById('upload-status');
  const fileInput = document.getElementById('upload-file');
  const memoInput = document.getElementById('upload-memo');
  const storeSelect = document.getElementById('upload-store-select');

  const storeId = storeSelect?.value || '';
  const store = state.stores.find((entry) => entry.id === storeId) || null;
  if (!store) {
    setStatus(statusEl, 'アップロード先のストアを選択してください。', 'error');
    return;
  }

  if (!fileInput?.files || fileInput.files.length === 0) {
    setStatus(statusEl, 'ファイルを選択してください。', 'error');
    return;
  }

  const formData = new FormData();
  formData.set('file', fileInput.files[0]);
  formData.set('fileSearchStoreName', store.geminiName);
  const memo = memoInput?.value.trim();
  if (memo) {
    formData.set('memo', memo);
  }

  setStatus(statusEl, 'アップロード中…', 'pending');

  try {
    const res = await authFetch('/api/documents', {
      method: 'POST',
      body: formData
    });
    const payload = await res.json().catch(() => null);

    if (res.status === 401 || res.status === 403) {
      setStatus(statusEl, '認証情報を確認してください。', 'error');
      updateAuthStatus('未接続', 'error');
      return;
    }

    if (!res.ok) {
      const message = summariseError(payload, res.status);
      setStatus(statusEl, message, 'error');
      pushActivity(`アップロードに失敗しました: ${message}`, 'error');
      return;
    }

    setStatus(statusEl, 'アップロードが完了しました。', 'success');
    pushActivity(`「${fileInput.files[0].name}」をアップロードしました。`, 'success');
    form.reset();
    renderStores();
  } catch (error) {
    console.error('[ui] failed to upload document', error);
    setStatus(statusEl, 'アップロードに失敗しました。', 'error');
    pushActivity('アップロードに失敗しました。', 'error');
  }
}

function setupEventHandlers() {
  const authForm = document.getElementById('auth-form');
  const tokenInput = document.getElementById('auth-token');
  const officeInput = document.getElementById('auth-office');
  const storeForm = document.getElementById('store-form');
  const uploadForm = document.getElementById('upload-form');
  const refreshButton = document.getElementById('refresh-stores');
  const storeSelect = document.getElementById('store-select');
  const uploadSelect = document.getElementById('upload-store-select');
  const storeList = document.getElementById('store-list');

  authForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const token = tokenInput?.value.trim() || '';
    const office = officeInput?.value.trim() || '';
    state.token = token;
    state.office = office;
    persistCredentials({ token, office });
    if (token) {
      updateAuthStatus('接続待機中', 'pending');
      loadStores();
    } else {
      updateAuthStatus('未接続', 'idle');
      state.stores = [];
      state.selectedStoreId = '';
      renderStores();
    }
  });

  storeForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.token) {
      setStatus(document.getElementById('store-status'), 'Bearer トークンを設定してください。', 'error');
      return;
    }
    createStore(storeForm);
  });

  uploadForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.token) {
      setStatus(document.getElementById('upload-status'), 'Bearer トークンを設定してください。', 'error');
      return;
    }
    uploadDocument(uploadForm);
  });

  refreshButton?.addEventListener('click', () => {
    loadStores();
  });

  storeSelect?.addEventListener('change', (event) => {
    const nextId = event.target.value;
    state.selectedStoreId = nextId;
    renderStores();
  });

  uploadSelect?.addEventListener('change', (event) => {
    const nextId = event.target.value;
    state.selectedStoreId = nextId;
    renderStores();
  });

  storeList?.addEventListener('click', (event) => {
    const target = event.target.closest('li[data-store-id]');
    if (!target) return;
    state.selectedStoreId = target.dataset.storeId || '';
    renderStores();
  });
  storeList?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const target = event.target.closest('li[data-store-id]');
    if (!target) return;
    event.preventDefault();
    state.selectedStoreId = target.dataset.storeId || '';
    renderStores();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const credentials = loadCredentials();
  state.token = credentials.token;
  state.office = credentials.office;

  const tokenInput = document.getElementById('auth-token');
  const officeInput = document.getElementById('auth-office');
  if (tokenInput) tokenInput.value = state.token;
  if (officeInput) officeInput.value = state.office;

  const footerYear = document.getElementById('footer-year');
  if (footerYear) {
    footerYear.textContent = new Date().getFullYear().toString();
  }

  updateAuthStatus(state.token ? '接続待機中' : '未接続', state.token ? 'pending' : 'idle');
  renderStores();
  setupEventHandlers();

  if (state.token) {
    loadStores();
  }
});
