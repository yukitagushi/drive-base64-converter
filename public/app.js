import { createClient } from 'https://esm.sh/@supabase/supabase-js@2?bundle';

let appShell;
let landingScreen;
let loginScreen;
let accountRequestTrigger;
let accountRequestDialog;
let accountRequestNotice;
let accountRequestConfirm;
let accountRequestCancel;
let landingRequestButton;
let loginBackButton;

let messageList;
let chatForm;
let chatInput;
let chatSubmitButton;
let statusIndicator;
let template;

let apiStatusPill;
let apiStatusText;
let refreshStoresBtn;
let storeList;
let storeEmpty;
let storeError;

let sessionOfficeSelect;
let sessionStaffSelect;
let startThreadBtn;
let threadList;
let sessionHint;

let openStoreBtn;
let storeDialog;
let storeForm;
let storeNameInput;
let storeFeedback;
let submitStoreBtn;

let openUploadBtn;
let uploadDialog;
let uploadForm;
let uploadFileInput;
let uploadSummary;
let uploadStoreSelect;
let uploadNotesInput;
let uploadFeedback;
let submitUploadBtn;

let documentList;
let documentForm;
let documentError;
let docTitle;
let docContent;

let authTrigger;
let authUserContainer;
let authUserButton;
let authUserInitial;
let authUserLabel;
let authMenu;
let authMenuName;
let authMenuEmail;
let authMenuLogout;
let authDialog;
let authTabs = [];
let authPanels = [];
let loginForm;
let loginEmailInput;
let loginPasswordInput;
let registerForm;
let registerNameInput;
let registerEmailInput;
let registerPasswordInput;
let registerOrganizationInput;
let registerOfficeInput;
let authFeedback;
let googleLoginBtn;
let googleHint;

let toastContainer;

let publicSupabaseConfig = null;

class HttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = options.status;
    this.body = options.body;
  }
}

function cacheDomElements() {
  appShell = document.querySelector('.app-shell');
  landingScreen = document.getElementById('landing-screen');
  loginScreen = document.getElementById('login-screen');
  accountRequestTrigger = document.getElementById('account-request-trigger');
  accountRequestDialog = document.getElementById('account-request-dialog');
  accountRequestNotice = document.getElementById('account-request-notice');
  accountRequestConfirm = document.getElementById('account-request-confirm');
  accountRequestCancel = document.getElementById('account-request-cancel');
  landingRequestButton = document.getElementById('landing-request');
  loginBackButton = document.getElementById('login-back');

  messageList = document.getElementById('message-list');
  chatForm = document.getElementById('chat-form');
  chatInput = document.getElementById('chat-input');
  chatSubmitButton = document.querySelector('#chat-form button[type="submit"]');
  statusIndicator = document.getElementById('status-indicator');
  template = document.getElementById('message-template');

  apiStatusPill = document.querySelector('.status-pill');
  apiStatusText = document.getElementById('api-status');
  refreshStoresBtn = document.getElementById('refresh-stores');
  storeList = document.getElementById('store-list');
  storeEmpty = document.getElementById('store-empty');
  storeError = document.getElementById('store-error');

  sessionOfficeSelect = document.getElementById('session-office');
  sessionStaffSelect = document.getElementById('session-staff');
  startThreadBtn = document.getElementById('start-thread');
  threadList = document.getElementById('thread-list');
  sessionHint = document.querySelector('.session-hint');

  openStoreBtn = document.getElementById('open-store');
  storeDialog = document.getElementById('store-dialog');
  storeForm = document.getElementById('store-form');
  storeNameInput = document.getElementById('store-name');
  storeFeedback = document.getElementById('store-feedback');
  submitStoreBtn = document.getElementById('submit-store');

  openUploadBtn = document.getElementById('open-upload');
  uploadDialog = document.getElementById('upload-dialog');
  uploadForm = document.getElementById('upload-form');
  uploadFileInput = document.getElementById('upload-file');
  uploadSummary = document.getElementById('upload-summary');
  uploadStoreSelect = document.getElementById('upload-store');
  uploadNotesInput = document.getElementById('upload-notes');
  uploadFeedback = document.getElementById('upload-feedback');
  submitUploadBtn = document.getElementById('submit-upload');

  documentList = document.getElementById('document-list');
  documentForm = document.getElementById('document-form');
  documentError = document.getElementById('document-error');
  docTitle = document.getElementById('doc-title');
  docContent = document.getElementById('doc-content');

  authTrigger = document.getElementById('auth-trigger');
  authUserContainer = document.getElementById('auth-user');
  authUserButton = document.getElementById('auth-user-button');
  authUserInitial = document.getElementById('auth-user-initial');
  authUserLabel = document.getElementById('auth-user-label');
  authMenu = document.getElementById('auth-menu');
  authMenuName = document.getElementById('auth-menu-name');
  authMenuEmail = document.getElementById('auth-menu-email');
  authMenuLogout = document.getElementById('auth-menu-logout');
  authDialog = document.getElementById('auth-dialog');
  authTabs = Array.from(document.querySelectorAll('[data-auth-tab]'));
  authPanels = Array.from(document.querySelectorAll('[data-auth-panel]'));
  loginForm = document.getElementById('login-form');
  loginEmailInput = document.getElementById('login-email');
  loginPasswordInput = document.getElementById('login-password');
  registerForm = document.getElementById('register-form');
  registerNameInput = document.getElementById('register-name');
  registerEmailInput = document.getElementById('register-email');
  registerPasswordInput = document.getElementById('register-password');
  registerOrganizationInput = document.getElementById('register-organization');
  registerOfficeInput = document.getElementById('register-office');
  authFeedback = document.getElementById('auth-feedback');
  googleLoginBtn = document.getElementById('google-login');
  googleHint = document.getElementById('google-hint');

  toastContainer = createToastContainer();
}

async function waitForDom() {
  if (document.readyState === 'loading') {
    await new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', resolve, { once: true });
    });
  }

  let attempts = 0;
  const requiredCheck = () =>
    appShell &&
    loginScreen &&
    messageList &&
    chatForm &&
    chatInput &&
    template &&
    openStoreBtn &&
    openUploadBtn &&
    authTrigger;

  cacheDomElements();
  if (requiredCheck()) {
    return;
  }

  while (!requiredCheck() && attempts < 5) {
    cacheDomElements();
    if (requiredCheck()) {
      break;
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    attempts += 1;
  }

  if (!requiredCheck()) {
    cacheDomElements();
  }
}

let conversationHistory = [];
let isSending = false;
let storeCache = [];
const storeFilesCache = new Map();

let supabaseBrowserClient = null;
let supabaseClientSignature = null;
let supabaseAuthSubscription = null;
let supabaseSessionState = {
  accessToken: null,
  refreshToken: null,
  provider: null,
};
let supabaseSessionSyncing = false;
let pendingSupabaseTokenPromise = null;
let authRecoveryScheduled = false;

const sessionState = {
  organizationId: null,
  officeId: null,
  staffId: null,
  threadId: null,
  supabaseConfigured: false,
};

const authState = {
  authenticated: false,
  user: null,
  staff: null,
  providers: { google: { enabled: false, url: null } },
  supabaseConfigured: false,
  authConfigured: false,
  supabase: null,
};

let organizationHierarchy = [];
let threadCache = [];
let hasBootstrapped = false;

let authMenuOpen = false;
let loginVisible = false;

const SAMPLE_NOTES = [
  {
    title: 'サンプル: Gemini への依頼方法',
    preview: '補助金・制度の質問は日付と対象者を明記して質問すると正確な回答になりやすいです。',
    tokens: 64,
  },
  {
    title: 'サンプル: アップロードのヒント',
    preview: 'PDF や議事録をファイルサーチに登録すると、チャットで即座に引用できるようになります。',
    tokens: 58,
  },
];

function normalizeStoreRow(row = {}) {
  const item = row || {};
  const fileCountValue =
    typeof item.fileCount === 'number'
      ? item.fileCount
      : typeof item.file_count === 'number'
      ? item.file_count
      : 0;
  const sizeBytesValue =
    typeof item.sizeBytes === 'number'
      ? item.sizeBytes
      : typeof item.size_bytes === 'number'
      ? item.size_bytes
      : 0;

  return {
    id: item.id || item.storeId || '',
    organizationId: item.organizationId || item.organization_id || null,
    officeId: item.officeId || item.office_id || null,
    geminiStoreName: item.geminiStoreName || item.gemini_store_name || item.name || '',
    displayName: item.displayName || item.display_name || item.name || '',
    description: item.description || null,
    createdBy: item.createdBy || item.created_by || null,
    createdAt: item.createdAt || item.created_at || null,
    fileCount: fileCountValue,
    sizeBytes: sizeBytesValue,
  };
}

function normalizeFileRow(row = {}) {
  const item = row || {};
  return {
    id: item.id || '',
    fileStoreId: item.fileStoreId || item.file_store_id || null,
    geminiFileName: item.geminiFileName || item.gemini_file_name || item.name || '',
    displayName: item.displayName || item.display_name || item.name || '',
    description: item.description || null,
    sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : typeof item.size_bytes === 'number' ? item.size_bytes : 0,
    mimeType: item.mimeType || item.mime_type || null,
    uploadedBy: item.uploadedBy || item.uploaded_by || null,
    uploadedAt: item.uploadedAt || item.uploaded_at || null,
    updatedAt: item.updatedAt || item.updated_at || null,
  };
}

function ensureAuthenticated(options = {}) {
  if (authState.authenticated) {
    return true;
  }

  const { message, toast = true, focusLogin = true } = options || {};
  if (toast !== false) {
    showToast(message || 'ログインすると操作できます。');
  }
  if (focusLogin !== false) {
    showLoginScreen();
  }
  return false;
}

function formatHttpError(error, fallbackMessage) {
  if (!error) {
    return fallbackMessage;
  }
  const message = error?.message || fallbackMessage;
  const status = error?.status;
  if (status) {
    return `(${status}) ${message}`;
  }
  return message;
}

async function getSupabaseAccessToken(options = {}) {
  const { force } = options || {};
  if (supabaseSessionState.accessToken && !force) {
    return supabaseSessionState.accessToken;
  }

  if (pendingSupabaseTokenPromise) {
    return pendingSupabaseTokenPromise;
  }

  const client = getSupabaseClient({ create: false });
  if (!client) {
    return supabaseSessionState.accessToken || null;
  }

  pendingSupabaseTokenPromise = (async () => {
    try {
      const { data, error } = await client.auth.getSession();
      if (error) {
        console.error('Failed to refresh Supabase session:', error);
        return supabaseSessionState.accessToken || null;
      }
      const session = data?.session || null;
      if (!session?.access_token) {
        if (supabaseSessionState.accessToken) {
          clearSupabaseSessionTokens();
        }
        return null;
      }
      setSupabaseSessionTokens(session);
      return session.access_token;
    } catch (error) {
      console.error('Supabase access token resolve error:', error);
      return supabaseSessionState.accessToken || null;
    } finally {
      pendingSupabaseTokenPromise = null;
    }
  })();

  return pendingSupabaseTokenPromise;
}

function scheduleAuthRecovery(message) {
  if (authRecoveryScheduled) {
    return;
  }
  authRecoveryScheduled = true;
  queueMicrotask(async () => {
    try {
      await syncSupabaseSessionFromClient({ force: true, forceLogout: true });
    } catch (error) {
      console.error('Auth recovery failed:', error);
    } finally {
      authRecoveryScheduled = false;
    }
    ensureAuthenticated({
      message: message || 'ログインセッションが無効になりました。再度ログインしてください。',
      toast: true,
      focusLogin: true,
    });
  });
}

async function safeFetch(url, options = {}) {
  const { skipAuthHandling = false, ...fetchOptions } = options || {};
  const mergedHeaders = { ...(fetchOptions?.headers || {}) };
  const requestBody = fetchOptions?.body;
  const isFormData = typeof FormData !== 'undefined' && requestBody instanceof FormData;
  const hasContentType = Object.keys(mergedHeaders).some((key) => key.toLowerCase() === 'content-type');
  if (!hasContentType && !isFormData) {
    mergedHeaders['Content-Type'] = 'application/json';
  }
  const hasAuthorization = Object.keys(mergedHeaders).some((key) => key.toLowerCase() === 'authorization');
  if (!hasAuthorization) {
    const token = await getSupabaseAccessToken();
    if (token) {
      mergedHeaders.Authorization = `Bearer ${token}`;
    }
  }

  const response = await fetch(url, { ...fetchOptions, headers: mergedHeaders });
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const responseBody = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      typeof responseBody === 'string'
        ? responseBody
        : responseBody?.error || (responseBody ? JSON.stringify(responseBody) : 'リクエストに失敗しました');
    if (!skipAuthHandling && response.status === 401 && authState.authenticated) {
      scheduleAuthRecovery(message);
    }
    throw new HttpError(message, { status: response.status, body: responseBody });
  }

  return responseBody;
}

function getCachedPublicSupabaseConfig() {
  return publicSupabaseConfig;
}

async function fetchPublicSupabaseConfig(options = {}) {
  if (publicSupabaseConfig && !options.force) {
    return publicSupabaseConfig;
  }

  try {
    const data = await safeFetch('/api/public-env');
    publicSupabaseConfig = {
      url: data?.supabaseUrl || null,
      anonKey: data?.anonKey || null,
    };
  } catch (error) {
    console.warn('Failed to load public Supabase environment:', error);
    publicSupabaseConfig = { url: null, anonKey: null };
  }

  return publicSupabaseConfig;
}

async function ensureSupabaseConfigFromPublicEnv(options = {}) {
  const env = await fetchPublicSupabaseConfig(options);
  if (!env?.url || !env?.anonKey) {
    return false;
  }

  const needsUpdate =
    !authState.supabase ||
    authState.supabase.url !== env.url ||
    authState.supabase.anonKey !== env.anonKey;

  if (needsUpdate) {
    authState.supabase = { url: env.url, anonKey: env.anonKey };
  }

  if (!hasSupabaseClient() || needsUpdate) {
    updateSupabaseClientFromState();
  }

  return true;
}

function updateSupabaseClientFromState() {
  const config = authState.supabase;
  const signature = config?.url && config?.anonKey ? `${config.url}::${config.anonKey}` : null;

  if (!signature) {
    supabaseBrowserClient = null;
    supabaseClientSignature = null;
    return false;
  }

  if (signature === supabaseClientSignature && supabaseBrowserClient) {
    return true;
  }

  try {
    supabaseBrowserClient = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    supabaseClientSignature = signature;
    attachSupabaseAuthListener();
    return true;
  } catch (error) {
    console.error('Failed to initialize Supabase client:', error);
    supabaseBrowserClient = null;
    supabaseClientSignature = null;
    return false;
  }
}

function getSupabaseClient(options = {}) {
  const { create = true } = options || {};
  if (!supabaseBrowserClient && create) {
    updateSupabaseClientFromState();
  }
  return supabaseBrowserClient;
}

function hasSupabaseClient() {
  return Boolean(getSupabaseClient({ create: false }));
}

function attachSupabaseAuthListener() {
  const client = getSupabaseClient({ create: false });
  if (!client || supabaseAuthSubscription) {
    return;
  }
  const { data } = client.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      if (session) {
        await finalizeSupabaseSession(session, { reason: event });
      }
    }
    if (event === 'SIGNED_OUT') {
      clearSupabaseSessionTokens();
      await loadAuth();
      handleLoggedOut();
    }
  });
  supabaseAuthSubscription = data?.subscription || null;
}

function setSupabaseSessionTokens(session) {
  if (!session) {
    clearSupabaseSessionTokens();
    return;
  }
  supabaseSessionState = {
    accessToken: session.access_token || null,
    refreshToken: session.refresh_token || null,
    provider: session.user?.app_metadata?.provider || null,
  };
}

function clearSupabaseSessionTokens() {
  supabaseSessionState = {
    accessToken: null,
    refreshToken: null,
    provider: null,
  };
  pendingSupabaseTokenPromise = null;
}

async function finalizeSupabaseSession(session, options = {}) {
  if (!session || !session.access_token) {
    return false;
  }

  const currentToken = supabaseSessionState.accessToken;
  const incomingToken = session.access_token;
  if (authState.authenticated && currentToken && currentToken === incomingToken && !options.force) {
    return true;
  }

  setSupabaseSessionTokens(session);

  try {
    const payload = await safeFetch('/api/auth/oauth-session', {
      method: 'POST',
      body: JSON.stringify({
        accessToken: session.access_token,
        refreshToken: session.refresh_token || null,
        provider: session.user?.app_metadata?.provider || options.provider || null,
      }),
      skipAuthHandling: true,
    });

    if (payload?.auth) {
      applyAuthState(payload.auth);
    }
    if (payload?.session) {
      applySessionPayload(payload.session);
    }
    try {
      await bootstrapAfterAuth({ force: true });
    } catch (error) {
      console.error(error);
    }
    closeDialog(authDialog);
    return true;
  } catch (error) {
    console.error(error);
    showToast(error?.message || 'ログインセッションの確立に失敗しました。', { type: 'error' });
    return false;
  }
}

async function syncSupabaseSessionFromClient(options = {}) {
  if (supabaseSessionSyncing) {
    return false;
  }

  const client = getSupabaseClient({ create: false });
  if (!client) {
    return false;
  }

  supabaseSessionSyncing = true;
  try {
    const { data, error } = await client.auth.getSession();
    if (error) {
      console.error('Failed to load Supabase session:', error);
      return false;
    }
    const session = data?.session || null;
    if (!session) {
      if (options.forceLogout && authState.authenticated) {
        clearSupabaseSessionTokens();
        await loadAuth();
        handleLoggedOut();
      }
      return false;
    }
    return await finalizeSupabaseSession(session, { ...options, force: options.force ?? false });
  } finally {
    supabaseSessionSyncing = false;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      init().catch((error) => console.error(error));
    },
    { once: true }
  );
} else {
  queueMicrotask(() => {
    init().catch((error) => console.error(error));
  });
}

async function init() {
  await waitForDom();
  await ensureSupabaseConfigFromPublicEnv();
  await loadAuth();
  await syncSupabaseSessionFromClient({ initial: true });
  if (authState.authenticated) {
    try {
      await bootstrapAfterAuth();
    } catch (error) {
      console.error(error);
    }
  } else {
    clearSessionData();
  }

  fetchState();
  autoResize(chatInput);
  autoResize(docContent);
  autoResize(uploadNotesInput);

  chatForm.addEventListener('submit', onChatSubmit);
  documentForm.addEventListener('submit', onDocumentSubmit);
  refreshStoresBtn.addEventListener('click', () => loadStores({ force: true }));

  openStoreBtn.addEventListener('click', handleOpenStoreDialog);
  openUploadBtn.addEventListener('click', handleOpenUploadDialog);

  sessionOfficeSelect.addEventListener('change', onSessionOfficeChange);
  sessionStaffSelect.addEventListener('change', onSessionStaffChange);
  startThreadBtn.addEventListener('click', onStartThread);
  threadList.addEventListener('click', onThreadListClick);

  storeForm.addEventListener('submit', onCreateStore);
  if (storeDialog) {
    storeDialog.addEventListener('close', () => {
      storeForm.reset();
      storeFeedback.textContent = '';
      submitStoreBtn.disabled = false;
    });
    storeDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(storeDialog);
    });
  }

  uploadForm.addEventListener('submit', onUploadFile);
  if (uploadDialog) {
    uploadDialog.addEventListener('close', () => {
      uploadForm.reset();
      uploadFeedback.textContent = '';
      uploadSummary.textContent = 'ファイルを選択すると詳細が表示されます。';
      uploadStoreSelect.disabled = !storeCache.length;
      submitUploadBtn.disabled = true;
    });
    uploadDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(uploadDialog);
    });
  }

  uploadFileInput.addEventListener('change', onUploadFileChange);
  uploadStoreSelect.addEventListener('change', updateUploadButtonState);

  document.addEventListener('click', (event) => {
    const closeTarget = event.target.closest('[data-close-dialog]');
    if (closeTarget) {
      const dialogId = closeTarget.getAttribute('data-close-dialog');
      const dialog = document.getElementById(dialogId);
      closeDialog(dialog);
    }
    if (authMenuOpen && !event.target.closest('.auth-user')) {
      closeAuthMenu();
    }
  });

  authTrigger?.addEventListener('click', showLoginScreen);
  loginBackButton?.addEventListener('click', hideLoginScreen);
  authUserButton?.addEventListener('click', onAuthUserButtonClick);
  authMenuLogout?.addEventListener('click', onLogout);
  authTabs.forEach((tab) => {
    tab.addEventListener('click', () => switchAuthTab(tab.dataset.authTab));
  });
  loginForm?.addEventListener('submit', onLoginSubmit);
  registerForm?.addEventListener('submit', onRegisterSubmit);
  googleLoginBtn?.addEventListener('click', onGoogleLogin);
  authDialog?.addEventListener('close', onAuthDialogClose);
  accountRequestTrigger?.addEventListener('click', () => openDialog(accountRequestDialog));
  landingRequestButton?.addEventListener('click', () => openDialog(accountRequestDialog));
  accountRequestCancel?.addEventListener('click', () => closeDialog(accountRequestDialog));
  accountRequestConfirm?.addEventListener('click', onAccountRequestConfirm);
  accountRequestDialog?.addEventListener('close', resetAccountRequestDialog);

  setupDialogDismissal(storeDialog);
  setupDialogDismissal(uploadDialog);
  setupDialogDismissal(authDialog);
  setupDialogDismissal(accountRequestDialog);

  storeList.addEventListener('click', onStoreListClick);
}

async function loadAuth() {
  try {
    const data = await safeFetch('/api/auth/state');
    if (data?.error) {
      throw new Error(data.error || '認証状態の取得に失敗しました');
    }
    applyAuthState(data);
  } catch (error) {
    console.error(error);
    applyAuthState({
      authenticated: false,
      user: null,
      staff: null,
      providers: { google: { enabled: false, url: null } },
      supabaseConfigured: false,
      authConfigured: false,
      supabase: null,
    });
  }
}

function applyAuthState(next) {
  if (!next || typeof next !== 'object') return;
  const wasAuthenticated = authState.authenticated;
  const previousSupabase = authState.supabase;
  authState.authenticated = Boolean(next.authenticated);
  authState.user = next.user || null;
  authState.staff = next.staff || null;
  authState.providers = next.providers || { google: { enabled: false, url: null } };
  authState.supabaseConfigured = Boolean(next.supabaseConfigured);
  authState.authConfigured = Boolean(next.authConfigured);
  const publicEnv = getCachedPublicSupabaseConfig();
  const resolvedSupabase =
    (next.supabase && next.supabase.url && next.supabase.anonKey ? next.supabase : null) ||
    (publicEnv && publicEnv.url && publicEnv.anonKey
      ? { url: publicEnv.url, anonKey: publicEnv.anonKey }
      : null) ||
    (previousSupabase && previousSupabase.url && previousSupabase.anonKey ? previousSupabase : null);
  authState.supabase = resolvedSupabase;
  updateSupabaseClientFromState();
  updateAuthUi();
  if (wasAuthenticated && !authState.authenticated) {
    handleLoggedOut();
  } else {
    updateSessionHint();
  }
}

function updateAuthUi() {
  const isAuthed = authState.authenticated;
  if (isAuthed && loginVisible) {
    loginVisible = false;
  }
  const showLogin = !isAuthed && loginVisible;
  const showApp = !showLogin;

  if (document.body) {
    document.body.classList.toggle('show-app', showApp);
    document.body.classList.toggle('show-login', showLogin);
    document.body.classList.toggle('is-guest', !isAuthed);
    document.body.classList.remove('show-landing');
  }
  if (appShell) {
    appShell.hidden = !showApp;
  }
  if (landingScreen) {
    landingScreen.hidden = true;
    landingScreen.setAttribute('aria-hidden', 'true');
    landingScreen.setAttribute('inert', '');
  }
  if (loginScreen) {
    loginScreen.hidden = !showLogin;
    loginScreen.setAttribute('aria-hidden', showLogin ? 'false' : 'true');
    if (showLogin) {
      loginScreen.removeAttribute('inert');
    } else {
      loginScreen.setAttribute('inert', '');
    }
  }
  if (authTrigger) {
    authTrigger.hidden = isAuthed;
    authTrigger.disabled = showLogin;
    authTrigger.setAttribute('aria-hidden', isAuthed ? 'true' : 'false');
  }
  if (authUserContainer) {
    authUserContainer.hidden = !isAuthed;
  }
  if (isAuthed && authState.user) {
    const name = authState.user.displayName || authState.user.email || 'ユーザー';
    if (authUserLabel) authUserLabel.textContent = name;
    if (authUserInitial) authUserInitial.textContent = getInitials(name);
    if (authMenuName) authMenuName.textContent = name;
    if (authMenuEmail) authMenuEmail.textContent = authState.user.email || '';
  } else {
    closeAuthMenu();
    if (authUserLabel) authUserLabel.textContent = 'ゲスト';
    if (authUserInitial) authUserInitial.textContent = 'G';
    if (authMenuName) authMenuName.textContent = '';
    if (authMenuEmail) authMenuEmail.textContent = '';
  }

  const googleProvider = authState.providers?.google || { enabled: false, url: null };
  const googleReady = googleProvider.enabled && hasSupabaseClient();

  if (googleLoginBtn) {
    googleLoginBtn.disabled = !googleReady;
    googleLoginBtn.classList.toggle('is-disabled', !googleReady);
    if (googleProvider.url) {
      googleLoginBtn.dataset.url = googleProvider.url;
    } else {
      delete googleLoginBtn.dataset.url;
    }
  }

  if (googleHint) {
    if (googleReady) {
      googleHint.textContent = 'Google アカウントで 1 クリックログインできます。';
    } else if (googleProvider.enabled && !hasSupabaseClient()) {
      googleHint.textContent = 'Supabase の公開キーを確認してください。';
    } else if (authState.authConfigured) {
      googleHint.textContent = 'Google ログインは現在利用できません。管理者にお問い合わせください。';
    } else {
      googleHint.textContent = 'Google OAuth を設定するとここからログインできます。';
    }
  }

  applyGuestUi(!isAuthed);
}

function applyGuestUi(isGuest) {
  const toggleInteractive = (element, disabled, options = {}) => {
    if (!element) return;
    const { disableElement = true } = options;

    if (disabled) {
      if (!element.dataset.guestDisabled) {
        element.dataset.guestDisabled = element.disabled ? 'persist' : 'temp';
      }

      if (disableElement) {
        element.disabled = true;
        element.classList?.add('is-disabled');
      } else {
        element.disabled = false;
        element.dataset.authRequired = '1';
        element.classList?.add('requires-auth');
      }
    } else if (element.dataset.guestDisabled) {
      const persist = element.dataset.guestDisabled === 'persist';
      delete element.dataset.guestDisabled;

      if (!disableElement) {
        delete element.dataset.authRequired;
      }

      if (!persist) {
        element.disabled = false;
      }

      if (!element.disabled) {
        element.classList?.remove('is-disabled');
        element.classList?.remove('requires-auth');
      }
    } else {
      if (!disableElement) {
        delete element.dataset.authRequired;
        element.classList?.remove('requires-auth');
      }

      if (!element.disabled) {
        element.classList?.remove('is-disabled');
      }
    }
  };

  toggleInteractive(openStoreBtn, isGuest, { disableElement: false });
  toggleInteractive(openUploadBtn, isGuest, { disableElement: false });
  toggleInteractive(refreshStoresBtn, isGuest);
  toggleInteractive(startThreadBtn, isGuest, { disableElement: false });

  if (chatInput) {
    chatInput.disabled = isGuest;
    chatInput.placeholder = isGuest ? 'ログインすると質問できます。' : 'Gemini に質問する...';
  }

  if (chatSubmitButton) {
    if (isGuest) {
      if (!chatSubmitButton.dataset.guestDisabled) {
        chatSubmitButton.dataset.guestDisabled = chatSubmitButton.disabled ? 'persist' : 'temp';
      }
      chatSubmitButton.disabled = true;
    } else if (chatSubmitButton.dataset.guestDisabled) {
      const persist = chatSubmitButton.dataset.guestDisabled === 'persist';
      delete chatSubmitButton.dataset.guestDisabled;
      if (!persist && !isSending) {
        chatSubmitButton.disabled = false;
      }
    } else if (!isSending && !authState.authenticated) {
      chatSubmitButton.disabled = true;
    }
  }

  if (sessionOfficeSelect) {
    sessionOfficeSelect.disabled = isGuest;
  }
  if (sessionStaffSelect) {
    sessionStaffSelect.disabled = isGuest;
  }

  if (!isGuest && chatSubmitButton && !isSending && !chatSubmitButton.disabled) {
    chatSubmitButton.classList?.remove('is-disabled');
  }

  if (storeFeedback && isGuest) {
    storeFeedback.textContent = '';
  }
  if (uploadFeedback && isGuest) {
    uploadFeedback.textContent = '';
  }
}

function showLoginScreen() {
  if (authState.authenticated) {
    return;
  }
  closeAuthMenu();
  loginVisible = true;
  updateAuthUi();
  window.requestAnimationFrame(() => {
    loginEmailInput?.focus();
  });
}

function hideLoginScreen() {
  if (authState.authenticated) {
    return;
  }
  loginVisible = false;
  setAuthFeedback('');
  updateAuthUi();
}

function handleLoggedOut() {
  hasBootstrapped = false;
  loginVisible = false;
  clearSupabaseSessionTokens();
  clearSessionData();
  updateAuthUi();
}

function clearSessionData() {
  sessionState.organizationId = null;
  sessionState.officeId = null;
  sessionState.staffId = null;
  sessionState.threadId = null;
  sessionState.supabaseConfigured = false;
  organizationHierarchy = [];
  threadCache = [];
  storeCache = [];
  storeFilesCache.clear();
  delete storeList.dataset.loading;
  if (storeError) {
    storeError.textContent = '';
  }
  renderSessionSelectors();
  renderThreads();
  renderStores();
  updateStoreSelect({ preserveSelection: false });
  renderDocuments([]);
  if (documentError) {
    documentError.textContent = '';
  }
  if (storeFeedback) {
    storeFeedback.textContent = '';
  }
  if (uploadSummary) {
    uploadSummary.textContent = 'ファイルを選択すると詳細が表示されます。';
  }
  if (uploadFeedback) {
    uploadFeedback.textContent = '';
  }
  if (submitUploadBtn) {
    submitUploadBtn.disabled = true;
  }
  resetConversation();
  updateSessionHint();
}

async function bootstrapAfterAuth(options = {}) {
  const force = Boolean(options.force);
  if (hasBootstrapped && !force) {
    return;
  }
  hasBootstrapped = true;
  await loadSession();
  await Promise.all([loadStores({ force: true }), loadDocuments()]);
}

function openAuthDialog(mode = 'login') {
  if (!authDialog || typeof authDialog.showModal !== 'function') return;
  switchAuthTab(mode);
  setAuthFeedback('');
  loginForm?.reset();
  registerForm?.reset();
  if (!authDialog.open) {
    authDialog.showModal();
  }
}

function switchAuthTab(target) {
  const normalized = target === 'register' ? 'register' : 'login';
  authTabs.forEach((tab) => {
    const active = tab.dataset.authTab === normalized;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  authPanels.forEach((panel) => {
    const active = panel.dataset.authPanel === normalized;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
}

function onAuthUserButtonClick(event) {
  event.preventDefault();
  if (!authState.authenticated) {
    openAuthDialog('login');
    return;
  }
  if (authMenuOpen) {
    closeAuthMenu();
  } else {
    openAuthMenu();
  }
}

function openAuthMenu() {
  if (!authMenu || !authUserButton) return;
  authMenu.classList.add('is-open');
  authUserButton.setAttribute('aria-expanded', 'true');
  authMenuOpen = true;
}

function closeAuthMenu() {
  if (!authMenu || !authUserButton) return;
  authMenu.classList.remove('is-open');
  authUserButton.setAttribute('aria-expanded', 'false');
  authMenuOpen = false;
}

function setAuthFeedback(message, options = {}) {
  if (!authFeedback) return;
  authFeedback.textContent = message || '';
  authFeedback.classList.toggle('is-visible', Boolean(message));
  authFeedback.classList.toggle('is-success', Boolean(message) && options.type === 'success');
}

function onAuthDialogClose() {
  setAuthFeedback('');
  loginForm?.reset();
  registerForm?.reset();
}

async function onLoginSubmit(event) {
  event.preventDefault();
  if (!loginEmailInput || !loginPasswordInput) return;
  const email = loginEmailInput.value.trim();
  const password = loginPasswordInput.value.trim();
  if (!email || !password) {
    setAuthFeedback('メールアドレスとパスワードを入力してください。');
    return;
  }

  setAuthFeedback('');
  const submitButton = loginForm.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'ログイン中...';
  }

  try {
    const supabase = getSupabaseClient({ create: false });
    if (supabase) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        throw error;
      }
      if (!data?.session) {
        setAuthFeedback('確認メールを送信しました。メールのリンクからログインを完了してください。', { type: 'success' });
        return;
      }
      const success = await finalizeSupabaseSession(data.session, { provider: 'email', force: true });
      if (success) {
        loginForm?.reset();
      }
      return;
    }

    const response = await safeFetch('/api/auth/login-email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      skipAuthHandling: true,
    });
    if (response?.error) {
      throw new Error(response.error || 'ログインに失敗しました');
    }
    if (response?.supabaseSession) {
      const supabaseSession = response.supabaseSession;
      setSupabaseSessionTokens({
        access_token: supabaseSession.accessToken || null,
        refresh_token: supabaseSession.refreshToken || null,
        user: {
          app_metadata: {
            provider: supabaseSession.provider || 'email',
          },
        },
      });
    }
    applyAuthState(response.auth);
    if (response.session) {
      applySessionPayload(response.session);
    }
    try {
      await bootstrapAfterAuth({ force: true });
    } catch (bootstrapError) {
      console.error(bootstrapError);
    }
    closeDialog(authDialog);
  } catch (error) {
    console.error(error);
    setAuthFeedback(error.message || 'ログインに失敗しました。');
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'メールアドレスでログイン';
    }
  }
}

async function onRegisterSubmit(event) {
  event.preventDefault();
  if (!registerEmailInput || !registerPasswordInput || !registerNameInput) return;
  const payload = {
    email: registerEmailInput.value.trim(),
    password: registerPasswordInput.value,
    name: registerNameInput.value.trim(),
    displayName: registerNameInput.value.trim(),
    orgName: registerOrganizationInput?.value.trim() || '',
    organizationName: registerOrganizationInput?.value.trim() || '',
    officeName: registerOfficeInput?.value.trim() || '',
  };

  if (!payload.email || !payload.password || !payload.name) {
    setAuthFeedback('氏名・メールアドレス・パスワードは必須です。');
    return;
  }

  setAuthFeedback('');
  const submitButton = registerForm.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = '登録中...';
  }

  try {
    const data = await safeFetch('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipAuthHandling: true,
    });
    if (data?.error) {
      throw new Error(data.error || '登録に失敗しました');
    }

    if (data?.auth || data?.session || data?.confirmationRequired !== undefined) {
      applyAuthState(data.auth);
      if (data.session) {
        applySessionPayload(data.session);
        loadStores({ force: true });
      }
      if (data.confirmationRequired) {
        setAuthFeedback('確認メールを送信しました。メールを確認してから再度ログインしてください。', {
          type: 'success',
        });
      } else {
        closeDialog(authDialog);
      }
      return;
    }

    if (data?.ok) {
      setAuthFeedback('登録が完了しました。登録したメールアドレスでログインしてください。', {
        type: 'success',
      });
      switchAuthTab('login');
      return;
    }

    setAuthFeedback('登録が完了しました。ログイン画面に移動してください。', { type: 'success' });
    switchAuthTab('login');
  } catch (error) {
    console.error(error);
    setAuthFeedback(error.message || '登録に失敗しました。');
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'アカウントを作成';
    }
  }
}

async function onLogout(event) {
  event?.preventDefault();
  if (!authState.authenticated) {
    return;
  }

  const button = authMenuLogout;
  if (button) {
    button.disabled = true;
    button.textContent = 'ログアウト中...';
  }

  try {
    const supabase = getSupabaseClient({ create: false });
    const tokenForLogout = supabaseSessionState.accessToken;
    if (supabase) {
      try {
        await supabase.auth.signOut();
      } catch (signOutError) {
        console.error(signOutError);
      }
    }
    const data = await safeFetch('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ accessToken: tokenForLogout }),
      skipAuthHandling: true,
    });
    if (data?.error) {
      throw new Error(data.error || 'ログアウトに失敗しました');
    }
    applyAuthState(data.auth);
    if (data.session) {
      applySessionPayload(data.session);
      loadStores({ force: true });
      resetConversation();
    }
    loginForm?.reset();
    setAuthFeedback('');
  } catch (error) {
    console.error(error);
    alert(error.message || 'ログアウトに失敗しました');
  } finally {
    clearSupabaseSessionTokens();
    if (button) {
      button.disabled = false;
      button.textContent = 'ログアウト';
    }
    closeAuthMenu();
  }
}

async function onGoogleLogin(event) {
  event.preventDefault();
  const button = event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : googleLoginBtn;
  const provider = authState.providers?.google;
  const supabase = getSupabaseClient();

  if (!provider?.enabled) {
    showToast('Google ログインは現在利用できません。', { type: 'error' });
    return;
  }

  if (!supabase) {
    if (provider?.url) {
      window.location.href = provider.url;
      return;
    }
    showToast('Supabase OAuth の設定が見つかりません。', { type: 'error' });
    return;
  }

  let redirectUrl = provider?.url || null;

  try {
    if (button) {
      button.disabled = true;
    }
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/`,
        skipBrowserRedirect: true,
      },
    });

    if (error) {
      throw error;
    }

    if (data?.url) {
      redirectUrl = data.url;
    }
  } catch (error) {
    console.error(error);
    showToast(error?.message || 'Google ログインに失敗しました。', { type: 'error' });
    redirectUrl = null;
  } finally {
    if (!redirectUrl && button) {
      button.disabled = false;
    }
  }

  if (redirectUrl) {
    window.location.assign(redirectUrl);
  }
}

function onAccountRequestConfirm(event) {
  event?.preventDefault();
  if (!accountRequestDialog) return;
  const stage = accountRequestDialog.dataset.stage || 'confirm';
  const email = (accountRequestDialog.dataset.contactEmail || 'info@example.com').trim();

  if (stage !== 'ready') {
    if (accountRequestNotice) {
      accountRequestNotice.textContent = `${email} 宛に申請メールの下書きを開きます。送信前に必要事項をご記入ください。`;
    }
    if (accountRequestConfirm) {
      accountRequestConfirm.textContent = 'メールを作成';
    }
    accountRequestDialog.dataset.stage = 'ready';
    return;
  }

  const subject = encodeURIComponent('アカウント発行申請');
  const body = encodeURIComponent(
    '以下の内容をご記入のうえ送信してください。\n\n企業名・事業所名:\nご担当者様名:\n電話番号:\n希望するスタッフ人数:\n利用開始希望日:\n補足事項:\n'
  );

  resetAccountRequestDialog();
  closeDialog(accountRequestDialog);
  window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
}

function resetAccountRequestDialog() {
  if (!accountRequestDialog) return;
  delete accountRequestDialog.dataset.stage;
  if (accountRequestConfirm) {
    accountRequestConfirm.textContent = 'はい';
  }
  if (accountRequestNotice) {
    accountRequestNotice.textContent = 'メールアプリを開いて申請メールを作成しますか？';
  }
}

function applySessionPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  organizationHierarchy = Array.isArray(payload.hierarchy) ? payload.hierarchy : [];
  sessionState.supabaseConfigured = Boolean(payload.supabaseConfigured);
  applySessionUpdate(payload.session, payload.threads);
  renderSessionSelectors();
  renderThreads();
}

async function loadSession() {
  if (!authState.authenticated) {
    return;
  }
  try {
    const data = await safeFetch('/api/session');
    if (data?.error) {
      throw new Error(data.error || 'セッション情報の取得に失敗しました');
    }
    applySessionPayload(data);
  } catch (error) {
    console.error(error);
    threadList.innerHTML = '<p class="empty-hint">セッション情報を読み込めませんでした。</p>';
    sessionOfficeSelect.disabled = true;
    sessionStaffSelect.disabled = true;
    updateSessionHint();
  }
}

function applySessionUpdate(nextSession, threads) {
  if (nextSession && typeof nextSession === 'object') {
    const previousThread = sessionState.threadId;
    sessionState.organizationId = nextSession.organizationId || null;
    sessionState.officeId = nextSession.officeId || null;
    sessionState.staffId = nextSession.staffId || null;
    sessionState.threadId = nextSession.threadId || null;
    if (typeof nextSession.supabaseConfigured === 'boolean') {
      sessionState.supabaseConfigured = nextSession.supabaseConfigured;
    }

    if (previousThread && previousThread !== sessionState.threadId) {
      resetConversation();
    }
  }

  if (Array.isArray(threads)) {
    threadCache = threads.map(normalizeThread).filter(Boolean);
    renderThreads();
  }

  updateSessionHint();
}

function renderSessionSelectors() {
  sessionOfficeSelect.innerHTML = '';
  sessionStaffSelect.innerHTML = '';

  if (!authState.authenticated) {
    sessionOfficeSelect.disabled = true;
    sessionStaffSelect.disabled = true;
    sessionOfficeSelect.innerHTML = '<option value="">ログインすると利用できます</option>';
    sessionStaffSelect.innerHTML = '<option value="">ログインすると利用できます</option>';
    return;
  }

  if (!organizationHierarchy.length) {
    sessionOfficeSelect.disabled = true;
    sessionStaffSelect.disabled = true;
    const officeMessage =
      sessionState.supabaseConfigured && !authState.authenticated
        ? 'ログインすると利用できます'
        : '事業所が未登録です';
    const staffMessage =
      sessionState.supabaseConfigured && !authState.authenticated
        ? 'ログインすると利用できます'
        : 'スタッフが未登録です';
    sessionOfficeSelect.innerHTML = `<option value="">${officeMessage}</option>`;
    sessionStaffSelect.innerHTML = `<option value="">${staffMessage}</option>`;
    return;
  }

  const officeFragment = document.createDocumentFragment();
  organizationHierarchy.forEach((org) => {
    const group = document.createElement('optgroup');
    group.label = org.name;
    (org.offices || []).forEach((office) => {
      const option = document.createElement('option');
      option.value = office.id;
      option.textContent = office.name;
      if (office.id === sessionState.officeId) {
        option.selected = true;
      }
      group.appendChild(option);
    });
    officeFragment.appendChild(group);
  });

  sessionOfficeSelect.appendChild(officeFragment);
  sessionOfficeSelect.disabled = false;

  const activeOffice = organizationHierarchy
    .flatMap((org) => org.offices || [])
    .find((office) => office.id === sessionState.officeId) ||
    organizationHierarchy[0]?.offices?.[0];

  if (!sessionState.officeId && activeOffice) {
    sessionState.officeId = activeOffice.id;
  }

  if (!activeOffice || !activeOffice.staff?.length) {
    sessionStaffSelect.disabled = true;
    sessionStaffSelect.innerHTML = '<option value="">スタッフが未登録です</option>';
  } else {
    const staffFragment = document.createDocumentFragment();
    activeOffice.staff.forEach((member) => {
      const option = document.createElement('option');
      option.value = member.id;
      option.textContent = `${member.displayName} (${member.email})`;
      const shouldSelect =
        member.id === sessionState.staffId || (!sessionState.staffId && staffFragment.childNodes.length === 0);
      if (shouldSelect) {
        option.selected = true;
        sessionState.staffId = member.id;
      }
      staffFragment.appendChild(option);
    });
    sessionStaffSelect.appendChild(staffFragment);
    sessionStaffSelect.disabled = false;
  }
}

function renderThreads() {
  threadList.innerHTML = '';

  if (!authState.authenticated) {
    threadList.innerHTML = '<p class="empty-hint">ログインするとスレッドが表示されます。</p>';
    return;
  }

  if (!threadCache.length) {
    threadList.innerHTML = '<p class="empty-hint">スレッドはまだありません。右上から新規作成できます。</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  threadCache.forEach((thread) => {
    const card = document.createElement('article');
    card.className = 'thread-card';
    card.dataset.threadId = thread.id;
    if (thread.id === sessionState.threadId) {
      card.classList.add('is-active');
    }

    const title = document.createElement('h4');
    title.className = 'thread-card__title';
    title.textContent = thread.title || '無題のスレッド';

    const meta = document.createElement('p');
    meta.className = 'thread-card__meta';
    meta.textContent = formatThreadMeta(thread);

    const preview = document.createElement('p');
    preview.className = 'thread-card__preview';
    const lastMessage = thread.lastMessage && typeof thread.lastMessage === 'string'
      ? { content: thread.lastMessage }
      : thread.lastMessage;
    preview.textContent = lastMessage?.content || 'まだメッセージがありません。';

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(preview);

    fragment.appendChild(card);
  });

  threadList.appendChild(fragment);
}

function updateSessionHint() {
  if (!sessionHint) return;
  if (!authState.authenticated) {
    sessionHint.textContent = 'ログインすると事業所ごとのスレッドが表示されます。';
  } else if (sessionState.supabaseConfigured) {
    sessionHint.textContent = 'スレッドを切り替えると会話履歴が Supabase に保存されます。';
  } else {
    sessionHint.textContent = 'スレッド切り替えはローカルセッション内でのみ保持されます。';
  }
}

function resetConversation() {
  conversationHistory = [];
  messageList.innerHTML = '';
  setStatus('ジェミニ準備完了');
}

function normalizeThread(thread) {
  if (!thread || !thread.id) return null;
  const last = thread.lastMessage || thread.last_message || null;
  return {
    id: thread.id,
    officeId: thread.officeId || thread.office_id || sessionState.officeId,
    staffId: thread.staffId || thread.staff_id || sessionState.staffId,
    title: thread.title || '無題のスレッド',
    createdAt: thread.createdAt || thread.created_at || new Date().toISOString(),
    updatedAt: thread.updatedAt || thread.updated_at || new Date().toISOString(),
    lastMessage: typeof last === 'string' ? { content: last } : last,
  };
}

function upsertThread(thread) {
  const normalized = normalizeThread(thread);
  if (!normalized) return;
  const index = threadCache.findIndex((item) => item.id === normalized.id);
  if (index === -1) {
    threadCache.unshift(normalized);
  } else {
    threadCache[index] = { ...threadCache[index], ...normalized };
  }
  renderThreads();
}

function formatThreadMeta(thread) {
  const pieces = [];
  const staff = findStaffById(thread.staffId);
  if (staff) {
    pieces.push(staff.displayName);
  }
  if (thread.updatedAt) {
    pieces.push(formatRelativeTime(thread.updatedAt));
  } else if (thread.createdAt) {
    pieces.push(formatRelativeTime(thread.createdAt));
  }
  return pieces.join(' · ') || '履歴なし';
}

function findStaffById(staffId) {
  if (!staffId) return null;
  for (const org of organizationHierarchy) {
    for (const office of org.offices || []) {
      const staff = (office.staff || []).find((member) => member.id === staffId);
      if (staff) return staff;
    }
  }
  return null;
}

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffMs = date.getTime() - Date.now();
  const thresholds = [
    { unit: 'day', ms: 86400000 },
    { unit: 'hour', ms: 3600000 },
    { unit: 'minute', ms: 60000 },
  ];

  const rtf = new Intl.RelativeTimeFormat('ja-JP', { numeric: 'auto' });
  for (const { unit, ms } of thresholds) {
    const value = Math.round(diffMs / ms);
    if (Math.abs(value) >= 1) {
      return rtf.format(value, unit);
    }
  }

  return 'たった今';
}

async function onSessionOfficeChange(event) {
  const officeId = event.target.value || null;
  await setSession({ officeId });
}

async function onSessionStaffChange(event) {
  const staffId = event.target.value || null;
  await setSession({ staffId });
}

async function onStartThread() {
  if (!ensureAuthenticated({ message: 'スレッドを管理するにはログインしてください。' })) {
    return;
  }
  if (!sessionState.officeId || !sessionState.staffId) {
    alert('先に事業所とスタッフを選択してください。');
    return;
  }

  startThreadBtn.disabled = true;
  startThreadBtn.textContent = '作成中...';

  try {
    const data = await safeFetch('/api/threads', {
      method: 'POST',
      body: JSON.stringify({
        session: {
          officeId: sessionState.officeId,
          staffId: sessionState.staffId,
        },
        query: chatInput.value.trim(),
      }),
    });
    if (data?.error) {
      throw new Error(data.error || 'スレッドの作成に失敗しました');
    }
    organizationHierarchy = data.hierarchy || organizationHierarchy;
    applySessionUpdate(data.session, data.threads);
    renderSessionSelectors();
  } catch (error) {
    console.error(error);
    alert(error.message);
  } finally {
    startThreadBtn.disabled = false;
    startThreadBtn.textContent = '新しいスレッドを開始';
  }
}

async function onThreadListClick(event) {
  const card = event.target.closest('[data-thread-id]');
  if (!card) return;
  const threadId = card.dataset.threadId;
  if (!threadId || threadId === sessionState.threadId) return;
  await setSession({ threadId });
}

async function setSession(partial) {
  try {
    const data = await safeFetch('/api/session', {
      method: 'POST',
      body: JSON.stringify(partial),
    });
    if (data?.error) {
      throw new Error(data.error || 'セッションの更新に失敗しました');
    }
    applySessionPayload(data);
    if (Object.prototype.hasOwnProperty.call(partial, 'officeId')) {
      loadStores({ force: true });
    }
  } catch (error) {
    console.error(error);
  }
}

async function fetchState() {
  try {
    const data = await safeFetch('/api/state');
    if (data?.error) throw new Error(data.error || '状態の取得に失敗しました');

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
  if (!authState.authenticated) {
    ensureAuthenticated({ message: 'チャットを利用するにはログインしてください。' });
    return;
  }
  if (isSending) return;

  const text = chatInput.value.trim();
  if (!text) return;

  if (chatSubmitButton) {
    chatSubmitButton.disabled = true;
  }
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
    const data = await safeFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        query: text,
        history: conversationHistory.slice(0, -1),
        session: {
          organizationId: sessionState.organizationId,
          officeId: sessionState.officeId,
          staffId: sessionState.staffId,
          threadId: sessionState.threadId,
        },
      }),
    });

    if (data?.error) {
      throw new Error(data.error || '応答の取得に失敗しました');
    }

    const answer = data.answer || '(回答なし)';
    updateMessage(loadingMessage, answer, data.context);
    conversationHistory.push({ role: 'model', content: answer });
    setStatus('ジェミニ準備完了');

    if (data.session || data.threads) {
      applySessionUpdate(data.session || sessionState, data.threads);
      renderSessionSelectors();
    }

    if (data.thread) {
      upsertThread(data.thread);
    }
  } catch (error) {
    console.error(error);
    updateMessage(loadingMessage, `エラー: ${error.message}`);
    setStatus('エラーが発生しました');
  } finally {
    isSending = false;
    if (chatSubmitButton) {
      chatSubmitButton.disabled = !authState.authenticated;
    }
    scrollToBottom();
  }
}

async function onDocumentSubmit(event) {
  event.preventDefault();
  if (!ensureAuthenticated({ message: 'カスタムノートを保存するにはログインしてください。' })) {
    return;
  }
  documentError.textContent = '';

  const title = docTitle.value.trim();
  const content = docContent.value.trim();
  if (!title || !content) {
    documentError.textContent = 'タイトルと内容を入力してください。';
    return;
  }

  try {
    const data = await safeFetch('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    });

    if (data?.error) {
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
  if (!authState.authenticated) {
    renderDocuments([]);
    return;
  }
  try {
    const data = await safeFetch('/api/documents');
    if (data?.error) throw new Error(data.error || 'ドキュメントの取得に失敗しました');
    const list = Array.isArray(data.documents) ? data.documents : Array.isArray(data.items) ? data.items : null;
    renderDocuments(list);
  } catch (error) {
    console.error(error);
    if (typeof error.message === 'string' && error.message.includes('fileStoreId')) {
      renderDocuments([]);
      return;
    }
    documentList.innerHTML = '<p class="form-error">ドキュメントを読み込めませんでした。</p>';
  }
}

async function loadStores(options = {}) {
  if (!authState.authenticated) {
    storeError.textContent = '';
    storeCache = [];
    renderStores();
    updateStoreSelect({ preserveSelection: false });
    return;
  }
  storeError.textContent = '';
  if (!options.silent) {
    storeList.dataset.loading = 'true';
  }
  try {
    const data = await safeFetch('/api/file-stores');
    if (data?.error) {
      throw new Error(data.error || 'ファイルストアの取得に失敗しました');
    }
    const rawItems = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.stores)
      ? data.stores
      : [];
    storeCache = rawItems.map((row) => normalizeStoreRow(row)).filter((item) => item.id && item.geminiStoreName);
    if (data.session) {
      applySessionUpdate(data.session, data.threads);
      renderSessionSelectors();
    }
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
  const list = documents && documents.length ? documents : SAMPLE_NOTES;

  for (const doc of list) {
    const card = document.createElement('article');
    card.className = 'document-card';
    if (!documents || !documents.length) {
      card.dataset.sample = 'true';
    }
    const title = document.createElement('h4');
    title.className = 'document-card__title';
    title.textContent = doc.title;
    const meta = document.createElement('p');
    meta.className = 'document-card__meta';
    const metaLabel = doc.source === 'user' ? 'カスタム' : doc.source === 'transcript' ? '原稿' : 'サンプル';
    meta.textContent = `${metaLabel} / 約${doc.tokens || Math.ceil((doc.preview || '').length / 3)}トークン`;
    const preview = document.createElement('p');
    preview.className = 'document-card__preview';
    preview.textContent = doc.preview;
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(preview);
    documentList.appendChild(card);
  }

  if (!documents || !documents.length) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = 'メモを追加すると、ここに保存済みの内容が表示されます。';
    documentList.appendChild(hint);
  }
}

function renderStores() {
  storeList.innerHTML = '';
  storeFilesCache.clear();

  if (!storeCache.length) {
    storeEmpty.style.display = 'block';
    if (!authState.authenticated) {
      storeEmpty.textContent = 'ログインすると事業所のストアが表示されます。';
    } else if (!sessionState.supabaseConfigured) {
      storeEmpty.textContent = 'まだストアがありません。まずはストアを作成してください。';
    } else {
      storeEmpty.textContent = 'まだストアがありません。まずはストアを作成してください。';
    }
    return;
  }

  storeEmpty.style.display = 'none';

  for (const store of storeCache) {
    const card = document.createElement('article');
    card.className = 'store-card';
    card.dataset.storeId = store.id;
    card.dataset.geminiStore = store.geminiStoreName;

    const header = document.createElement('div');
    header.className = 'store-card__header';
    const title = document.createElement('h4');
    title.className = 'store-title';
    title.textContent = store.displayName || store.geminiStoreName;
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
      <span>ID: ${escapeHtml(store.geminiStoreName)}</span>
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
  if (!ensureAuthenticated({ message: 'ストアを作成するにはログインしてください。' })) {
    return;
  }
  storeFeedback.textContent = '';

  const name = storeNameInput.value.trim();
  if (!name) {
    storeFeedback.textContent = 'ストア名を入力してください。';
    return;
  }

  submitStoreBtn.disabled = true;
  submitStoreBtn.textContent = '作成中...';

  try {
    const data = await safeFetch('/api/file-stores', {
      method: 'POST',
      body: JSON.stringify({ displayName: name }),
    });
    if (data?.error) {
      throw new Error(data.error || 'ストアの作成に失敗しました');
    }
    closeDialog(storeDialog);
    await loadStores({ silent: true });
  } catch (error) {
    console.error(error);
    storeFeedback.textContent = formatHttpError(error, 'ストアの作成に失敗しました。');
  } finally {
    submitStoreBtn.disabled = false;
    submitStoreBtn.textContent = '作成';
  }
}

async function onUploadFile(event) {
  event.preventDefault();
  if (!ensureAuthenticated({ message: 'ファイルをアップロードするにはログインしてください。' })) {
    return;
  }
  uploadFeedback.textContent = '';

  const file = uploadFileInput.files?.[0];
  const storeId = uploadStoreSelect.value;

  if (!file) {
    uploadFeedback.textContent = 'ファイルを選択してください。';
    return;
  }
  if (!storeId) {
    uploadFeedback.textContent = '保存先のストアを選択してください。';
    return;
  }

  if (!storeCache.some((entry) => entry.id === storeId)) {
    uploadFeedback.textContent = '選択したストアが見つかりません。再読み込みしてください。';
    return;
  }

  try {
    submitUploadBtn.disabled = true;
    submitUploadBtn.textContent = 'アップロード中...';

    const formData = new FormData();
    formData.append('fileStoreId', storeId);
    formData.append('file', file);
    formData.append('displayName', file.name);
    const notes = uploadNotesInput.value.trim();
    if (notes) {
      formData.append('memo', notes);
    }

    const data = await safeFetch('/api/documents', {
      method: 'POST',
      body: formData,
    });
    if (data?.error) {
      throw new Error(data.error || 'アップロードに失敗しました');
    }

    closeDialog(uploadDialog);
    showToast('ファイルをアップロードしました。');
    await loadStores({ silent: true });

    const uploaded = normalizeFileRow(data.item || data.file);
    if (uploaded && uploaded.fileStoreId) {
      const existing = storeFilesCache.get(uploaded.fileStoreId) || [];
      storeFilesCache.set(uploaded.fileStoreId, [uploaded, ...existing]);
    } else {
      storeFilesCache.delete(storeId);
    }
  } catch (error) {
    console.error(error);
    uploadFeedback.textContent = formatHttpError(error, 'ファイルのアップロードに失敗しました。');
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

function handleOpenStoreDialog() {
  if (!ensureAuthenticated({ message: 'ストアを作成するにはログインしてください。' })) {
    return;
  }

  storeForm.reset();
  storeFeedback.textContent = '';
  submitStoreBtn.disabled = false;
  openDialog(storeDialog);
}

function handleOpenUploadDialog() {
  if (!ensureAuthenticated({ message: 'ファイルをアップロードするにはログインしてください。' })) {
    return;
  }

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
  const storeId = card.dataset.storeId;
  if (!storeId) return;

  if (button.dataset.action === 'toggle-files') {
    await toggleStoreFiles(card, button, storeId);
  }
}

async function toggleStoreFiles(card, button, storeId) {
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
    let files = storeFilesCache.get(storeId);
    if (!files) {
      const data = await safeFetch(`/api/documents?fileStoreId=${encodeURIComponent(storeId)}`);
      if (data?.error) {
        throw new Error(data.error || 'ファイル一覧の取得に失敗しました');
      }
      const rawFiles = Array.isArray(data.items) ? data.items : Array.isArray(data.files) ? data.files : [];
      files = rawFiles.map((row) => normalizeFileRow(row));
      storeFilesCache.set(storeId, files);
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
    const timestamp = file.uploadedAt || file.updatedAt || file.updateTime || file.createTime || file.createdAt;
    right.textContent = `${formatBytes(file.sizeBytes || 0)} / ${formatDate(timestamp)}`;
    row.appendChild(left);
    row.appendChild(right);
    container.appendChild(row);
  }
}

function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) {
      dialog.showModal();
    }
    return;
  }

  if (!dialog.hasAttribute('open')) {
    dialog.setAttribute('open', '');
  }
  dialog.dataset.fallbackOpen = '1';
  dialog.classList.add('is-open');
  dialog.dispatchEvent(new Event('open'));
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') {
    try {
      dialog.close();
      return;
    } catch (error) {
      // browsers without <dialog> support may throw; fallback below
    }
  }

  if (dialog.dataset.fallbackOpen === '1' || dialog.hasAttribute('open')) {
    delete dialog.dataset.fallbackOpen;
    dialog.removeAttribute('open');
    dialog.classList.remove('is-open');
    dialog.dispatchEvent(new Event('close'));
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

function updateStoreSelect(options = {}) {
  if (!uploadStoreSelect) return;
  const { preserveSelection = true, defaultToFirst = false } = options;
  const previousValue = preserveSelection ? uploadStoreSelect.value : '';
  let firstValue = '';

  uploadStoreSelect.innerHTML = '<option value="">ストアを選択してください</option>';
  for (const store of storeCache) {
    const option = document.createElement('option');
    option.value = store.id;
    option.textContent = store.displayName || store.geminiStoreName;
    uploadStoreSelect.appendChild(option);
    if (!firstValue) {
      firstValue = store.id;
    }
  }

  let nextValue = '';
  if (previousValue && storeCache.some((store) => store.id === previousValue)) {
    nextValue = previousValue;
  } else if (defaultToFirst && firstValue) {
    nextValue = firstValue;
  }

  if (nextValue) {
    uploadStoreSelect.value = nextValue;
  }

  uploadStoreSelect.disabled = !storeCache.length;
  updateUploadButtonState();
}

function setupDialogDismissal(dialog) {
  if (!dialog) return;
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      closeDialog(dialog);
    }
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog(dialog);
  });
}

function createToastContainer() {
  const existing = document.querySelector('.toast-container');
  if (existing) {
    return existing;
  }
  const element = document.createElement('div');
  element.className = 'toast-container';
  const attach = () => {
    if (!element.isConnected && document.body) {
      document.body.appendChild(element);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  } else {
    attach();
  }
  return element;
}

function showToast(message, options = {}) {
  if (!toastContainer) {
    console.warn('Toast container is not available.');
    return;
  }
  const { type = 'info', duration = 4500 } = options;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  toastContainer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('is-visible');
  });

  const removeToast = () => {
    toast.classList.remove('is-visible');
    setTimeout(() => {
      toast.remove();
    }, 180);
  };

  const timer = setTimeout(removeToast, duration);
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    removeToast();
  });
}

function getInitials(value) {
  if (!value) return 'U';
  const text = String(value).trim();
  if (!text) return 'U';
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  const first = parts[0].charAt(0);
  const last = parts[parts.length - 1].charAt(0);
  return `${first}${last}`.toUpperCase();
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
