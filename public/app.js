import { setTokenProvider, setWorkspaceProvider } from './js/api-client.js';
import { initializeFileStoreUI } from './js/file-stores.js';

const STORAGE_KEY = 'gemini-lounge-auth';

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
    console.warn('[ui] failed to parse stored credentials', error);
  }
  return { token: '', office: '' };
}

function saveCredentials(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('[ui] failed to persist credentials', error);
  }
}

function setConnectionStatus(text, status) {
  const statusEl = document.getElementById('connection-status');
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.status = status;
}

function setupThemeToggle() {
  const button = document.getElementById('toggle-theme');
  if (!button) return;
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? '' : 'dark';
    if (next) {
      document.documentElement.dataset.theme = next;
    } else {
      delete document.documentElement.dataset.theme;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const authForm = document.getElementById('auth-form');
  const tokenInput = document.getElementById('auth-token');
  const officeInput = document.getElementById('auth-office');

  const credentials = loadCredentials();
  if (tokenInput) {
    tokenInput.value = credentials.token;
  }
  if (officeInput) {
    officeInput.value = credentials.office;
  }

  setTokenProvider(() => credentials.token);
  setWorkspaceProvider(() => credentials.office);
  setConnectionStatus(credentials.token ? '接続待機中' : '未接続', credentials.token ? 'pending' : 'idle');

  authForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const token = tokenInput?.value.trim() ?? '';
    const office = officeInput?.value.trim() ?? '';
    credentials.token = token;
    credentials.office = office;
    saveCredentials(credentials);
    setTokenProvider(() => credentials.token);
    setWorkspaceProvider(() => credentials.office);
    setConnectionStatus(token ? '接続済み' : '未接続', token ? 'success' : 'idle');
    if (!token) {
      setConnectionStatus('未接続', 'idle');
    }
  });

  const storeDialog = document.getElementById('store-dialog');
  const initializer = initializeFileStoreUI({
    getWorkspace: () => credentials.office,
    onRequireAuth: () => {
      setConnectionStatus('未接続', 'error');
    },
    elements: {
      statusEl: document.getElementById('store-status'),
      listEl: document.getElementById('store-list'),
      selectEl: document.getElementById('store-select'),
      uploadSelectEl: document.getElementById('upload-store-select'),
      templateEl: document.getElementById('store-item-template'),
      storeForm: document.getElementById('store-form'),
      storeDialog,
      uploadForm: document.getElementById('upload-form'),
      uploadStatusEl: document.getElementById('upload-status'),
      refreshButtons: [
        document.getElementById('refresh-stores'),
        document.getElementById('card-refresh-stores')
      ],
      openDialogButtons: [
        document.getElementById('open-store-dialog'),
        document.getElementById('card-open-store-dialog')
      ],
      dialogDismissButtons: Array.from(
        storeDialog?.querySelectorAll('[data-dismiss]') ?? []
      ),
      metaDisplay: document.getElementById('meta-display-name'),
      metaGemini: document.getElementById('meta-gemini-name'),
      metaDescription: document.getElementById('meta-description'),
      metaCreatedAt: document.getElementById('meta-created-at'),
      activityLog: document.getElementById('activity-log')
    }
  });

  // Refresh list when credentials change.
  authForm?.addEventListener('submit', () => {
    initializer.refresh();
  });

  setupThemeToggle();
});
