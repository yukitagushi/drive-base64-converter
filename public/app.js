const messageList = document.getElementById('message-list');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const statusIndicator = document.getElementById('status-indicator');
const template = document.getElementById('message-template');

const apiStatusPill = document.querySelector('.status-pill');
const apiStatusText = document.getElementById('api-status');
const refreshStoresBtn = document.getElementById('refresh-stores');
const storeList = document.getElementById('store-list');
const storeEmpty = document.getElementById('store-empty');
const storeError = document.getElementById('store-error');

const openStoreBtn = document.getElementById('open-store');
const storeDialog = document.getElementById('store-dialog');
const storeForm = document.getElementById('store-form');
const storeNameInput = document.getElementById('store-name');
const storeFeedback = document.getElementById('store-feedback');
const submitStoreBtn = document.getElementById('submit-store');

const openUploadBtn = document.getElementById('open-upload');
const uploadDialog = document.getElementById('upload-dialog');
const uploadForm = document.getElementById('upload-form');
const uploadFileInput = document.getElementById('upload-file');
const uploadSummary = document.getElementById('upload-summary');
const uploadStoreSelect = document.getElementById('upload-store');
const uploadNotesInput = document.getElementById('upload-notes');
const uploadFeedback = document.getElementById('upload-feedback');
const submitUploadBtn = document.getElementById('submit-upload');

const documentList = document.getElementById('document-list');
const documentForm = document.getElementById('document-form');
const documentError = document.getElementById('document-error');
const docTitle = document.getElementById('doc-title');
const docContent = document.getElementById('doc-content');

let conversationHistory = [];
let isSending = false;
let storeCache = [];
const storeFilesCache = new Map();

init();

function init() {
  fetchState();
  loadStores();
  loadDocuments();
  autoResize(chatInput);
  autoResize(docContent);
  autoResize(uploadNotesInput);

  chatForm.addEventListener('submit', onChatSubmit);
  documentForm.addEventListener('submit', onDocumentSubmit);
  refreshStoresBtn.addEventListener('click', () => loadStores({ force: true }));

  openStoreBtn.addEventListener('click', () => openDialog(storeDialog));
  openUploadBtn.addEventListener('click', handleOpenUploadDialog);

  storeForm.addEventListener('submit', onCreateStore);
  storeDialog.addEventListener('close', () => {
    storeForm.reset();
    storeFeedback.textContent = '';
    submitStoreBtn.disabled = false;
  });

  uploadForm.addEventListener('submit', onUploadFile);
  uploadDialog.addEventListener('close', () => {
    uploadForm.reset();
    uploadFeedback.textContent = '';
    uploadSummary.textContent = 'ファイルを選択すると詳細が表示されます。';
    uploadStoreSelect.disabled = !storeCache.length;
    submitUploadBtn.disabled = true;
  });

  uploadFileInput.addEventListener('change', onUploadFileChange);
  uploadStoreSelect.addEventListener('change', updateUploadButtonState);

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-close-dialog]');
    if (!target) return;
    const dialogId = target.getAttribute('data-close-dialog');
    const dialog = document.getElementById(dialogId);
    if (dialog && typeof dialog.close === 'function') {
      dialog.close();
    }
  });

  setupDialogDismissal(storeDialog);
  setupDialogDismissal(uploadDialog);

  storeList.addEventListener('click', onStoreListClick);
}

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '状態の取得に失敗しました');

    if (!data.hasApiKey) {
      apiStatusPill.classList.remove('ready');
      apiStatusText.textContent = 'APIキーを環境変数 GOOGLE_API_KEY に設定してください。';
      statusIndicator.textContent = 'APIキー未設定';
      return;
    }

    if (!data.ready) {
      apiStatusPill.classList.remove('ready');
      apiStatusText.textContent = data.error ? `初期化エラー: ${data.error}` : 'ナレッジを準備しています...';
    } else {
      apiStatusPill.classList.add('ready');
      apiStatusText.textContent = 'Gemini API 接続済み';
    }

    statusIndicator.textContent = data.ready ? 'ジェミニ準備完了' : '初期化中...';
    renderDocuments(data.documents);
  } catch (error) {
    console.error(error);
    apiStatusPill.classList.remove('ready');
    apiStatusText.textContent = '状態の取得に失敗しました';
    statusIndicator.textContent = 'ステータス取得に失敗しました';
  }
}

async function onChatSubmit(event) {
  event.preventDefault();
  if (isSending) return;

  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  chatInput.style.height = 'auto';

  appendMessage('user', text);
  conversationHistory.push({ role: 'user', content: text });
  scrollToBottom();

  const loadingMessage = appendMessage('model', 'Gemini が考えています...', { loading: true });
  scrollToBottom();

  isSending = true;
  setStatus('Gemini が応答を生成中...');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: text,
        history: conversationHistory.slice(0, -1),
      }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || '応答の取得に失敗しました');
    }

    const answer = data.answer || '(回答なし)';
    updateMessage(loadingMessage, answer, data.context);
    conversationHistory.push({ role: 'model', content: answer });
    setStatus('ジェミニ準備完了');
  } catch (error) {
    console.error(error);
    updateMessage(loadingMessage, `エラー: ${error.message}`);
    setStatus('エラーが発生しました');
  } finally {
    isSending = false;
    scrollToBottom();
  }
}

async function onDocumentSubmit(event) {
  event.preventDefault();
  documentError.textContent = '';

  const title = docTitle.value.trim();
  const content = docContent.value.trim();
  if (!title || !content) {
    documentError.textContent = 'タイトルと内容を入力してください。';
    return;
  }

  try {
    const res = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || '追加に失敗しました');
    }

    docTitle.value = '';
    docContent.value = '';
    docContent.style.height = 'auto';
    documentError.textContent = '保存しました。埋め込みを更新しています...';
    renderDocuments(data.documents);
    await fetchState();
  } catch (error) {
    console.error(error);
    documentError.textContent = error.message;
  }
}

async function loadDocuments() {
  try {
    const res = await fetch('/api/documents');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ドキュメントの取得に失敗しました');
    renderDocuments(data.documents);
  } catch (error) {
    console.error(error);
    documentList.innerHTML = '<p class="form-error">ドキュメントを読み込めませんでした。</p>';
  }
}

async function loadStores(options = {}) {
  storeError.textContent = '';
  if (!options.silent) {
    storeList.dataset.loading = 'true';
  }
  try {
    const res = await fetch('/api/file-stores');
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'ファイルストアの取得に失敗しました');
    }
    storeCache = Array.isArray(data.stores) ? data.stores : [];
    renderStores();
    updateStoreSelect();
  } catch (error) {
    console.error(error);
    storeError.textContent = error.message;
    storeCache = [];
    renderStores();
    updateStoreSelect();
  } finally {
    delete storeList.dataset.loading;
  }
}

function renderDocuments(documents) {
  documentList.innerHTML = '';
  if (!documents || !documents.length) {
    documentList.innerHTML = '<p class="empty-hint">カスタムノートはまだありません。</p>';
    return;
  }

  for (const doc of documents) {
    const card = document.createElement('article');
    card.className = 'document-card';
    const title = document.createElement('h4');
    title.textContent = doc.title;
    const meta = document.createElement('p');
    meta.textContent = `${doc.source === 'user' ? 'カスタム' : '原稿'} / 約${doc.tokens}トークン`;
    const preview = document.createElement('p');
    preview.textContent = doc.preview;
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(preview);
    documentList.appendChild(card);
  }
}

function renderStores() {
  storeList.innerHTML = '';
  storeFilesCache.clear();

  if (!storeCache.length) {
    storeEmpty.style.display = 'block';
    return;
  }

  storeEmpty.style.display = 'none';

  for (const store of storeCache) {
    const card = document.createElement('article');
    card.className = 'store-card';
    card.dataset.storeName = store.name;

    const header = document.createElement('div');
    header.className = 'store-card__header';
    const title = document.createElement('h4');
    title.className = 'store-title';
    title.textContent = store.displayName || store.name;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn btn-chip';
    action.dataset.action = 'toggle-files';
    action.textContent = 'ファイル一覧';
    header.appendChild(title);
    header.appendChild(action);

    const meta = document.createElement('div');
    meta.className = 'store-meta';
    meta.innerHTML = `
      <span>ID: ${escapeHtml(store.name)}</span>
      <span>ファイル ${store.fileCount ?? 0} 件</span>
      <span>${formatBytes(store.sizeBytes || 0)}</span>
    `;

    const filesContainer = document.createElement('div');
    filesContainer.className = 'store-files';
    filesContainer.hidden = true;

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(filesContainer);
    storeList.appendChild(card);
  }
}

async function onCreateStore(event) {
  event.preventDefault();
  storeFeedback.textContent = '';

  const name = storeNameInput.value.trim();
  if (!name) {
    storeFeedback.textContent = 'ストア名を入力してください。';
    return;
  }

  submitStoreBtn.disabled = true;
  submitStoreBtn.textContent = '作成中...';

  try {
    const res = await fetch('/api/file-stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'ストアの作成に失敗しました');
    }
    storeDialog.close();
    await loadStores({ silent: true });
  } catch (error) {
    console.error(error);
    storeFeedback.textContent = error.message;
  } finally {
    submitStoreBtn.disabled = false;
    submitStoreBtn.textContent = '作成';
  }
}

async function onUploadFile(event) {
  event.preventDefault();
  uploadFeedback.textContent = '';

  const file = uploadFileInput.files?.[0];
  const storeName = uploadStoreSelect.value;

  if (!file) {
    uploadFeedback.textContent = 'ファイルを選択してください。';
    return;
  }
  if (!storeName) {
    uploadFeedback.textContent = '保存先のストアを選択してください。';
    return;
  }

  try {
    submitUploadBtn.disabled = true;
    submitUploadBtn.textContent = 'アップロード中...';

    const base64 = await readFileAsBase64(file);
    const res = await fetch(`/api/file-stores/${encodeURIComponent(storeName)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
        description: uploadNotesInput.value.trim(),
        data: base64,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'アップロードに失敗しました');
    }

    uploadDialog.close();
    await loadStores({ silent: true });
    storeFilesCache.delete(storeName);
  } catch (error) {
    console.error(error);
    uploadFeedback.textContent = error.message;
  } finally {
    submitUploadBtn.disabled = false;
    submitUploadBtn.textContent = 'アップロード';
  }
}

function onUploadFileChange() {
  uploadFeedback.textContent = '';
  const file = uploadFileInput.files?.[0];
  if (!file) {
    uploadSummary.textContent = 'ファイルを選択すると詳細が表示されます。';
    uploadStoreSelect.value = '';
    submitUploadBtn.disabled = true;
    return;
  }

  uploadSummary.textContent = `${file.name} / ${formatBytes(file.size)}`;
  uploadStoreSelect.disabled = !storeCache.length;
  updateUploadButtonState();
}

function updateUploadButtonState() {
  const hasFile = Boolean(uploadFileInput.files && uploadFileInput.files[0]);
  const hasStore = Boolean(uploadStoreSelect.value);
  submitUploadBtn.disabled = !(hasFile && hasStore);
}

function handleOpenUploadDialog() {
  uploadForm.reset();
  uploadFeedback.textContent = '';
  uploadSummary.textContent = 'ファイルを選択すると詳細が表示されます。';
  updateStoreSelect({ preserveSelection: false, defaultToFirst: true });
  uploadStoreSelect.disabled = !storeCache.length;
  updateUploadButtonState();
  openDialog(uploadDialog);
}

async function onStoreListClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const card = button.closest('.store-card');
  if (!card) return;
  const storeName = card.dataset.storeName;
  if (!storeName) return;

  if (button.dataset.action === 'toggle-files') {
    await toggleStoreFiles(card, button, storeName);
  }
}

async function toggleStoreFiles(card, button, storeName) {
  const container = card.querySelector('.store-files');
  const isOpen = container && !container.hidden;

  if (!container) return;

  if (isOpen) {
    container.hidden = true;
    container.innerHTML = '';
    button.textContent = 'ファイル一覧';
    return;
  }

  button.disabled = true;
  button.textContent = '読み込み中...';
  container.innerHTML = '';
  container.hidden = false;

  try {
    let files = storeFilesCache.get(storeName);
    if (!files) {
      const res = await fetch(`/api/file-stores/${encodeURIComponent(storeName)}/files`);
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'ファイル一覧の取得に失敗しました');
      }
      files = Array.isArray(data.files) ? data.files : [];
      storeFilesCache.set(storeName, files);
    }
    renderFileList(container, files);
    button.textContent = '閉じる';
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
    button.textContent = '再読み込み';
  } finally {
    button.disabled = false;
  }
}

function renderFileList(container, files) {
  container.innerHTML = '';
  if (!files.length) {
    container.innerHTML = '<p class="empty-hint">まだファイルがありません。</p>';
    return;
  }

  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const left = document.createElement('span');
    left.textContent = file.displayName || file.name;
    const right = document.createElement('span');
    right.textContent = `${formatBytes(file.sizeBytes || 0)} / ${formatDate(file.updateTime || file.createTime)}`;
    row.appendChild(left);
    row.appendChild(right);
    container.appendChild(row);
  }
}

function openDialog(dialog) {
  if (dialog && typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal();
  }
}

function appendMessage(role, text, options = {}) {
  const fragment = template.content.cloneNode(true);
  const article = fragment.querySelector('.message');
  const meta = fragment.querySelector('.message-meta');
  const body = fragment.querySelector('.message-body');

  article.classList.add(role);
  if (options.loading) {
    article.classList.add('loading');
  }

  meta.textContent = role === 'user' ? 'User' : 'Gemini';
  body.textContent = text;

  messageList.appendChild(fragment);
  const articleEl = messageList.lastElementChild;
  return {
    article: articleEl,
    meta: articleEl.querySelector('.message-meta'),
    body: articleEl.querySelector('.message-body'),
  };
}

function updateMessage(messageRefs, text, context) {
  if (!messageRefs) return;
  const { article, body } = messageRefs;
  article.classList.remove('loading');
  body.textContent = text;

  if (context && Array.isArray(context) && context.length > 0) {
    const footnote = document.createElement('div');
    footnote.className = 'message-sources';
    context.forEach((item, index) => {
      const tag = document.createElement('span');
      tag.textContent = `ソース${index + 1}: ${item.title} (score: ${item.score.toFixed(2)})`;
      footnote.appendChild(tag);
    });
    body.appendChild(document.createElement('br'));
    body.appendChild(footnote);
  }
}

function setStatus(message) {
  statusIndicator.textContent = message;
}

function scrollToBottom() {
  messageList.scrollTo({ top: messageList.scrollHeight, behavior: 'smooth' });
}

function autoResize(textarea) {
  if (!textarea) return;
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  };
  textarea.addEventListener('input', resize);
  resize();
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        const base64 = result.split(',')[1] || '';
        resolve(base64);
      } else {
        reject(new Error('ファイルの読み込みに失敗しました'));
      }
    };
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });
}

function updateStoreSelect(options = {}) {
  if (!uploadStoreSelect) return;
  const { preserveSelection = true, defaultToFirst = false } = options;
  const previousValue = preserveSelection ? uploadStoreSelect.value : '';
  let firstValue = '';

  uploadStoreSelect.innerHTML = '<option value="">ストアを選択してください</option>';
  for (const store of storeCache) {
    const option = document.createElement('option');
    option.value = store.name;
    option.textContent = store.displayName || store.name;
    uploadStoreSelect.appendChild(option);
    if (!firstValue) {
      firstValue = store.name;
    }
  }

  let nextValue = '';
  if (previousValue && storeCache.some((store) => store.name === previousValue)) {
    nextValue = previousValue;
  } else if (defaultToFirst && firstValue) {
    nextValue = firstValue;
  }

  if (nextValue) {
    uploadStoreSelect.value = nextValue;
  }

  updateUploadButtonState();
}

function setupDialogDismissal(dialog) {
  if (!dialog) return;
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDate(value) {
  if (!value) return '日時不明';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日時不明';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
