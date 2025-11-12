(() => {
  const form = document.querySelector('[data-file-store-form]');
  const displayNameInput = document.querySelector('[data-file-store-display-name]');
  const descriptionInput = document.querySelector('[data-file-store-description]');
  const select = document.querySelector('[data-file-store-select]');
  const statusEl = document.querySelector('[data-file-store-status]');
  const listEl = document.querySelector('[data-file-store-list]');

  async function fetchStores() {
    try {
      const res = await fetch('/api/file-stores', { headers: { 'cache-control': 'no-cache' } });
      if (res.status === 405) {
        renderStores([]);
        return;
      }
      if (!res.ok) {
        throw new Error(`Failed to load stores: ${res.status}`);
      }
      const payload = await res.json();
      const stores = Array.isArray(payload?.stores) ? payload.stores : [];
      renderStores(stores);
    } catch (error) {
      console.error('[app] failed to fetch stores', error);
      renderStatus('ストア一覧の取得に失敗しました。', 'error');
    }
  }

  function renderStores(stores) {
    if (select) {
      select.innerHTML = '';
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = 'ストアを選択';
      select.appendChild(defaultOption);

      for (const store of stores) {
        const option = document.createElement('option');
        option.value = store.geminiName || store.id;
        option.textContent = store.displayName || store.id;
        option.dataset.storeId = store.id;
        select.appendChild(option);
      }
    }

    if (listEl) {
      listEl.innerHTML = '';
      for (const store of stores) {
        const item = document.createElement('li');
        item.textContent = `${store.displayName || store.id} (${store.id})`;
        listEl.appendChild(item);
      }
    }
  }

  function renderStatus(message, type) {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message;
    statusEl.dataset.state = type;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!displayNameInput) {
      renderStatus('フォームが正しく初期化されていません。', 'error');
      return;
    }

    const payload = {
      displayName: displayNameInput.value.trim(),
      description: descriptionInput ? descriptionInput.value.trim() : undefined
    };

    if (!payload.displayName) {
      renderStatus('表示名を入力してください。', 'error');
      return;
    }

    renderStatus('作成中…', 'pending');

    try {
      const res = await fetch('/api/file-stores', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          displayName: payload.displayName,
          ...(payload.description ? { description: payload.description } : {})
        })
      });

      const data = await res.json();

      if (!res.ok) {
        const message = data?.detail
          ? `作成に失敗しました: ${JSON.stringify(data.detail)}`
          : '作成に失敗しました。';
        renderStatus(message, 'error');
        return;
      }

      renderStatus('ストアを作成しました。', 'success');
      if (displayNameInput) {
        displayNameInput.value = '';
      }
      if (descriptionInput) {
        descriptionInput.value = '';
      }

      if (data?.store) {
        mergeStoreIntoSelect(data.store);
      } else {
        await fetchStores();
      }
    } catch (error) {
      console.error('[app] failed to create store', error);
      renderStatus('ストアの作成に失敗しました。', 'error');
    }
  }

  function mergeStoreIntoSelect(store) {
    if (!select) {
      return;
    }
    const existing = select.querySelector(`option[data-store-id="${store.id}"]`);
    if (existing) {
      existing.textContent = store.displayName || store.id;
      existing.value = store.geminiName || store.id;
      return;
    }
    const option = document.createElement('option');
    option.value = store.geminiName || store.id;
    option.textContent = store.displayName || store.id;
    option.dataset.storeId = store.id;
    select.appendChild(option);
    select.value = option.value;
  }

  if (form) {
    form.addEventListener('submit', handleSubmit);
  }

  fetchStores();
})();
