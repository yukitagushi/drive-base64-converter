import { authFetch } from './api-client.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function summariseError(payload, status) {
  if (!payload) {
    return `リクエストに失敗しました (status: ${status}).`;
  }
  const source = payload.source === 'gemini' ? 'Gemini API' : 'API';
  if (typeof payload.error === 'string') {
    return `${source} エラー: ${payload.error}`;
  }
  if (isPlainObject(payload.detail)) {
    return `${source} エラー: ${JSON.stringify(payload.detail)}`;
  }
  if (typeof payload.detail === 'string') {
    return `${source} エラー: ${payload.detail}`;
  }
  return `${source} エラー (status: ${status}).`;
}

function setStatus(el, message, status) {
  if (!el) return;
  el.textContent = message || '';
  if (status) {
    el.dataset.status = status;
  } else {
    delete el.dataset.status;
  }
}

function normaliseStore(store) {
  if (!isPlainObject(store)) {
    return null;
  }
  const id = typeof store.id === 'string' ? store.id : '';
  const displayName = typeof store.displayName === 'string' ? store.displayName : id;
  const geminiName = typeof store.geminiName === 'string' ? store.geminiName : '';
  if (!id || !geminiName) {
    return null;
  }
  return {
    id,
    displayName,
    description: typeof store.description === 'string' ? store.description : '',
    geminiName,
    createdAt: typeof store.createdAt === 'string' ? store.createdAt : '',
    debugId: typeof store.debugId === 'string' ? store.debugId : undefined
  };
}

function renderStores(state, elements) {
  const { stores, selectedStoreId } = state;
  const { listEl, selectEl, uploadSelectEl, templateEl } = elements;

  if (selectEl) {
    selectEl.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'ストアを選択';
    selectEl.appendChild(placeholder);
  }

  if (uploadSelectEl) {
    uploadSelectEl.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'ストアを選択';
    uploadSelectEl.appendChild(placeholder);
  }

  if (listEl) {
    listEl.innerHTML = '';
  }

  for (const store of stores) {
    if (selectEl) {
      const option = document.createElement('option');
      option.value = store.geminiName;
      option.textContent = store.displayName || store.id;
      option.dataset.storeId = store.id;
      if (store.id === selectedStoreId) {
        option.selected = true;
      }
      selectEl.appendChild(option);
    }

    if (uploadSelectEl) {
      const option = document.createElement('option');
      option.value = store.geminiName;
      option.textContent = store.displayName || store.id;
      option.dataset.storeId = store.id;
      uploadSelectEl.appendChild(option);
    }

    if (listEl) {
      let item;
      if (templateEl?.content) {
        const fragment = templateEl.content.cloneNode(true);
        item = fragment.querySelector('li') || document.createElement('li');
        const titleEl = fragment.querySelector('.store-item-title');
        if (titleEl) {
          titleEl.textContent = store.displayName || store.id;
        }
        const metaEl = fragment.querySelector('.store-item-meta');
        if (metaEl) {
          metaEl.textContent = store.geminiName;
        }
        item.dataset.storeId = store.id;
        listEl.appendChild(fragment);
      } else {
        item = document.createElement('li');
        item.textContent = `${store.displayName || store.id} (${store.geminiName})`;
        item.dataset.storeId = store.id;
        listEl.appendChild(item);
      }
    }
  }
}

function updateMeta(state, elements) {
  const { selectedStoreId, stores } = state;
  const target = stores.find((entry) => entry.id === selectedStoreId) || null;
  const { metaDisplay, metaGemini, metaDescription, metaCreatedAt } = elements;
  const fallback = '—';
  if (metaDisplay) {
    metaDisplay.textContent = target?.displayName || fallback;
  }
  if (metaGemini) {
    metaGemini.textContent = target?.geminiName || fallback;
  }
  if (metaDescription) {
    metaDescription.textContent = target?.description || fallback;
  }
  if (metaCreatedAt) {
    metaCreatedAt.textContent = target?.createdAt || fallback;
  }
}

function pushActivity(logEl, message, status = 'info') {
  if (!logEl) return;
  const item = document.createElement('li');
  item.dataset.status = status;
  item.textContent = message;
  logEl.prepend(item);
  while (logEl.children.length > 20) {
    logEl.removeChild(logEl.lastElementChild);
  }
}

export function initializeFileStoreUI(config) {
  const {
    getWorkspace,
    elements,
    onRequireAuth
  } = config;

  const state = {
    stores: [],
    selectedStoreId: ''
  };

  async function fetchStores(showPending = true) {
    if (showPending) {
      setStatus(elements.statusEl, 'ストア一覧を取得しています…', 'pending');
    }

    try {
      const res = await authFetch('/api/file-stores', {
        headers: { 'cache-control': 'no-cache' }
      });
      const payload = await res.json().catch(() => null);

      if (res.status === 401 || res.status === 403) {
        setStatus(elements.statusEl, '認証が必要です。Bearer トークンを設定してください。', 'error');
        onRequireAuth?.();
        state.stores = [];
        renderStores(state, elements);
        updateMeta(state, elements);
        return;
      }

      if (!res.ok) {
        const message = summariseError(payload, res.status);
        setStatus(elements.statusEl, message, 'error');
        return;
      }

      const stores = Array.isArray(payload?.stores) ? payload.stores : [];
      const normalized = stores
        .map(normaliseStore)
        .filter(Boolean)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

      state.stores = normalized;
      if (!state.stores.find((entry) => entry.id === state.selectedStoreId)) {
        state.selectedStoreId = state.stores[0]?.id || '';
      }

      renderStores(state, elements);
      updateMeta(state, elements);
      if (payload?.debugId) {
        pushActivity(elements.activityLog, `GET /api/file-stores (${payload.debugId})`, 'info');
      }

      if (state.stores.length === 0) {
        setStatus(elements.statusEl, 'ストアがまだありません。', 'info');
      } else {
        setStatus(elements.statusEl, `${state.stores.length} 件のストアを取得しました。`, 'success');
      }
    } catch (error) {
      console.error('[ui] failed to fetch stores', error);
      setStatus(elements.statusEl, 'ストアの取得に失敗しました。', 'error');
    }
  }

  async function handleStoreSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const formData = new FormData(form);
    const displayName = (formData.get('displayName') || '').toString().trim();
    const description = (formData.get('description') || '').toString().trim();

    if (!displayName) {
      setStatus(elements.statusEl, '表示名を入力してください。', 'error');
      return;
    }

    setStatus(elements.statusEl, 'ストアを作成しています…', 'pending');

    try {
      const res = await authFetch('/api/file-stores', {
        method: 'POST',
        body: JSON.stringify({
          displayName,
          ...(description ? { description } : {})
        })
      });

      const payload = await res.json().catch(() => null);

      if (res.status === 401 || res.status === 403) {
        setStatus(elements.statusEl, '認証エラー: Bearer トークンを確認してください。', 'error');
        onRequireAuth?.();
        return;
      }

      if (res.status === 409) {
        setStatus(elements.statusEl, '同じ ID または表示名のストアが既に存在します。', 'error');
        return;
      }

      if (!res.ok || !payload?.store) {
        const message = summariseError(payload, res.status);
        setStatus(elements.statusEl, message, 'error');
        return;
      }

      const store = normaliseStore(payload.store);
      if (!store) {
        setStatus(elements.statusEl, 'ストア情報の解析に失敗しました。', 'error');
        return;
      }

      state.stores = [...state.stores.filter((entry) => entry.id !== store.id), store];
      state.selectedStoreId = store.id;
      renderStores(state, elements);
      updateMeta(state, elements);
      setStatus(elements.statusEl, 'ストアを作成しました。', 'success');
      pushActivity(
        elements.activityLog,
        `ストア「${store.displayName || store.id}」を作成 (${payload.debugId || 'local'})`,
        'success'
      );

      if (elements.storeDialog?.open) {
        elements.storeDialog.close();
      }
      form.reset();
    } catch (error) {
      console.error('[ui] failed to create store', error);
      setStatus(elements.statusEl, 'ストアの作成に失敗しました。', 'error');
    }
  }

  function handleStoreSelectionChange(event) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }
    const selectedOption = target.selectedOptions[0];
    const storeId = selectedOption?.dataset.storeId || '';
    state.selectedStoreId = storeId;
    updateMeta(state, elements);
    if (elements.uploadSelectEl && target === elements.selectEl) {
      const geminiName = selectedOption?.value || '';
      if (geminiName) {
        elements.uploadSelectEl.value = geminiName;
      }
    }
  }

  async function handleUploadSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const formData = new FormData(form);
    const storeName = formData.get('fileSearchStoreName');
    if (!storeName || typeof storeName !== 'string' || !storeName.startsWith('fileSearchStores/')) {
      setStatus(elements.uploadStatusEl, 'アップロード先ストアを選択してください。', 'error');
      return;
    }

    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setStatus(elements.uploadStatusEl, 'ファイルを選択してください。', 'error');
      return;
    }

    setStatus(elements.uploadStatusEl, 'アップロード中です…', 'pending');

    try {
      const res = await authFetch('/api/documents', {
        method: 'POST',
        body: formData
      });

      const payload = await res.json().catch(() => null);
      if (res.status === 401 || res.status === 403) {
        setStatus(elements.uploadStatusEl, '認証エラー: Bearer トークンを確認してください。', 'error');
        onRequireAuth?.();
        return;
      }

      if (!res.ok) {
        const message = summariseError(payload, res.status);
        setStatus(elements.uploadStatusEl, message, 'error');
        return;
      }

      setStatus(elements.uploadStatusEl, 'アップロードが完了しました。', 'success');
      pushActivity(
        elements.activityLog,
        `ドキュメント「${file.name}」をアップロード (${payload?.debugId || 'local'})`,
        'success'
      );
      form.reset();
      if (elements.uploadSelectEl) {
        elements.uploadSelectEl.value = state.selectedStoreId
          ? state.stores.find((entry) => entry.id === state.selectedStoreId)?.geminiName || ''
          : '';
      }
    } catch (error) {
      console.error('[ui] failed to upload document', error);
      setStatus(elements.uploadStatusEl, 'アップロードに失敗しました。', 'error');
    }
  }

  elements.storeForm?.addEventListener('submit', handleStoreSubmit);
  elements.selectEl?.addEventListener('change', handleStoreSelectionChange);
  elements.uploadForm?.addEventListener('submit', handleUploadSubmit);
  elements.refreshButtons?.forEach((btn) =>
    btn?.addEventListener('click', () => {
      void fetchStores();
    })
  );

  if (elements.listEl) {
    elements.listEl.addEventListener('click', (event) => {
      const li = (event.target instanceof HTMLElement && event.target.closest('li')) || null;
      if (!li || !li.dataset.storeId) return;
      state.selectedStoreId = li.dataset.storeId;
      if (elements.selectEl) {
        const option = elements.selectEl.querySelector(`option[data-store-id="${state.selectedStoreId}"]`);
        if (option) {
          option.selected = true;
        }
      }
      updateMeta(state, elements);
    });
  }

  elements.openDialogButtons?.forEach((btn) =>
    btn?.addEventListener('click', () => {
      elements.storeDialog?.showModal();
    })
  );

  elements.dialogDismissButtons?.forEach((btn) =>
    btn?.addEventListener('click', () => {
      if (elements.storeDialog?.open) {
        elements.storeDialog.close();
      }
    })
  );

  elements.storeDialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    elements.storeDialog?.close();
  });

  if (typeof getWorkspace === 'function') {
    const workspace = getWorkspace();
    if (workspace) {
      pushActivity(elements.activityLog, `ワークスペース: ${workspace}`, 'info');
    }
  }

  void fetchStores(false);

  return {
    refresh: () => fetchStores(true)
  };
}
