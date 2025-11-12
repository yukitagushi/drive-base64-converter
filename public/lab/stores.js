import { setTokenProvider, setWorkspaceProvider } from '../js/api-client.js';
import { initializeFileStoreUI } from '../js/file-stores.js';

const STORAGE_KEY = 'gemini-lounge-auth';

function readToken() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string') {
      return parsed.token;
    }
  } catch (error) {
    console.warn('[lab] failed to read stored token', error);
  }
  return '';
}

const token = readToken();
setTokenProvider(() => token);
setWorkspaceProvider(() => 'lab');

initializeFileStoreUI({
  getWorkspace: () => 'lab',
  onRequireAuth: () => {
    const statusEl = document.querySelector('[data-file-store-status]');
    if (statusEl) {
      statusEl.textContent = 'Bearer トークンが設定されていません。メイン UI から設定してください。';
      statusEl.dataset.state = 'error';
    }
  },
  elements: {
    statusEl: document.querySelector('[data-file-store-status]'),
    listEl: document.querySelector('[data-file-store-list]'),
    selectEl: document.querySelector('[data-file-store-select]'),
    storeForm: document.querySelector('[data-file-store-form]'),
    uploadForm: null,
    uploadStatusEl: null,
    templateEl: null,
    storeDialog: null,
    refreshButtons: [],
    openDialogButtons: [],
    dialogDismissButtons: [],
    uploadSelectEl: null,
    metaDisplay: null,
    metaGemini: null,
    metaDescription: null,
    metaCreatedAt: null,
    activityLog: null
  }
});
