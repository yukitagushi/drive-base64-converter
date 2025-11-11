const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const state = {
  config: null,
  stores: [],
  activeStore: null,
  conversations: new Map(),
  loadingStores: false,
  pendingChat: false,
};

const dom = {
  storesList: document.getElementById("storesList"),
  refreshStores: document.getElementById("refreshStores"),
  openStoreModal: document.getElementById("openStoreModal"),
  openKeyModal: document.getElementById("openKeyModal"),
  openUploadModal: document.getElementById("openUploadModal"),
  keyModal: document.querySelector('[data-modal="key"]'),
  storeModal: document.querySelector('[data-modal="store"]'),
  uploadModal: document.querySelector('[data-modal="upload"]'),
  chatStream: document.getElementById("chatStream"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  chatSubmit: document.querySelector("#chatForm button[type='submit']"),
  chatSection: document.getElementById("chatSection"),
  activeStoreTitle: document.getElementById("activeStoreTitle"),
  activeStoreMeta: document.getElementById("activeStoreMeta"),
  clearConversation: document.getElementById("clearConversation"),
  statusToast: document.getElementById("statusToast"),
  storeTemplate: document.getElementById("storeTemplate"),
  messageTemplate: document.getElementById("messageTemplate"),
};

init();

function init() {
  bindModals();
  restoreConfig();
  if (!state.config) {
    openModal(dom.keyModal);
  } else {
    populateKeyForm(state.config);
    refreshStoresList();
  }

  dom.refreshStores.addEventListener("click", () => refreshStoresList());
  dom.openStoreModal.addEventListener("click", () => openModal(dom.storeModal));
  dom.openKeyModal.addEventListener("click", () => {
    populateKeyForm(state.config || {});
    openModal(dom.keyModal);
  });
  dom.openUploadModal.addEventListener("click", () => openModal(dom.uploadModal));

  document.getElementById("keyForm").addEventListener("submit", handleSaveConfig);
  document.getElementById("storeForm").addEventListener("submit", handleCreateStore);
  document.getElementById("uploadForm").addEventListener("submit", handleUploadFile);
  document.getElementById("uploadFile").addEventListener("change", handleFilePreview);
  const dropZone = dom.uploadModal.querySelector(".file-drop");
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("is-dragging");
  });
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    if (event.dataTransfer?.files?.length) {
      const fileInput = document.getElementById("uploadFile");
      fileInput.files = event.dataTransfer.files;
      handleFilePreview();
    }
  });

  dom.chatForm.addEventListener("submit", handleChatSubmit);
  dom.chatInput.addEventListener("input", autoResizeInput);
  dom.clearConversation.addEventListener("click", () => {
    if (!state.activeStore) return;
    state.conversations.set(state.activeStore.name, []);
    renderConversation();
  });
}

function bindModals() {
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = btn.closest(".modal-backdrop");
      closeModal(modal);
    });
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        closeModal(backdrop);
      }
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      document
        .querySelectorAll(".modal-backdrop:not([hidden])")
        .forEach((modal) => closeModal(modal));
    }
  });
}

function openModal(modal) {
  if (!modal) return;
  modal.hidden = false;
}

function closeModal(modal) {
  if (!modal) return;
  modal.hidden = true;
  const form = modal.querySelector("form");
  if (form) form.reset();
  if (modal === dom.uploadModal) {
    document.getElementById("uploadLabel").textContent =
      "ファイルを選択またはドロップ (PDF / TXT / MD など)";
  }
}

function restoreConfig() {
  try {
    const raw = localStorage.getItem("gemini-config");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.apiKey && parsed.projectId && parsed.location) {
        state.config = parsed;
      }
    }
  } catch (error) {
    console.error("Failed to restore config", error);
  }
}

function populateKeyForm(config) {
  document.getElementById("apiKey").value = config.apiKey || "";
  document.getElementById("projectId").value = config.projectId || "";
  document.getElementById("location").value = config.location || "global";
}

function handleSaveConfig(event) {
  event.preventDefault();
  const apiKey = document.getElementById("apiKey").value.trim();
  const projectId = document.getElementById("projectId").value.trim();
  const location = document.getElementById("location").value.trim() || "global";
  if (!apiKey || !projectId) {
    toast("API 設定を入力してください", true);
    return;
  }
  state.config = { apiKey, projectId, location };
  localStorage.setItem("gemini-config", JSON.stringify(state.config));
  closeModal(dom.keyModal);
  toast("API 設定を保存しました");
  refreshStoresList();
}

async function refreshStoresList() {
  if (!ensureConfig()) return;
  state.loadingStores = true;
  renderStores();
  try {
    const stores = await listStores();
    state.stores = stores;
    if (
      state.activeStore &&
      !stores.find((store) => store.name === state.activeStore.name)
    ) {
      state.activeStore = null;
    }
    renderStores();
    if (state.activeStore) {
      selectStore(state.activeStore.name, false);
    }
  } catch (error) {
    console.error(error);
    toast("ストアの取得に失敗しました", true);
  } finally {
    state.loadingStores = false;
  }
}

function renderStores() {
  dom.storesList.innerHTML = "";
  if (state.loadingStores) {
    dom.storesList.innerHTML = `<p class="muted">読込中...</p>`;
    return;
  }
  if (!state.stores.length) {
    dom.storesList.innerHTML = `<p class="muted">ストアがありません。右上のボタンから作成しましょう。</p>`;
    return;
  }
  for (const store of state.stores) {
    const node = dom.storeTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector("h3").textContent = store.displayName || simplifyName(store.name);
    node.dataset.storeName = store.name;
    node.querySelector(".store-meta").textContent =
      `${simplifyName(store.name)} • ${store.description || ""}`.trim();
    const filesList = node.querySelector(".store-files");
    if (store.files && store.files.length) {
      for (const file of store.files.slice(0, 5)) {
        const item = document.createElement("li");
        const label = file.displayName || file.name?.split("/").pop();
        item.textContent = `${label} (${file.mimeType || "unknown"})`;
        filesList.appendChild(item);
      }
      if (store.files.length > 5) {
        const more = document.createElement("li");
        more.textContent = `... 他 ${store.files.length - 5} 件`;
        filesList.appendChild(more);
      }
    } else {
      const empty = document.createElement("li");
      empty.textContent = "ファイル未登録";
      filesList.appendChild(empty);
    }

    node.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (!action) return;
      event.stopPropagation();
      const actionType = action.dataset.action;
      if (actionType === "set-active") {
        selectStore(store.name);
      } else if (actionType === "upload") {
        selectStore(store.name, false);
        openModal(dom.uploadModal);
      } else if (actionType === "delete") {
        confirmDeleteStore(store);
      } else if (actionType === "refresh") {
        reloadStoreDetails(store.name);
      }
    });

    if (state.activeStore && state.activeStore.name === store.name) {
      node.classList.add("active");
    }

    dom.storesList.appendChild(node);
  }
}

function ensureConfig() {
  if (!state.config) {
    toast("まず API 設定を保存してください", true);
    openModal(dom.keyModal);
    return false;
  }
  return true;
}

async function handleCreateStore(event) {
  event.preventDefault();
  if (!ensureConfig()) return;
  const name = document.getElementById("storeName").value.trim();
  const description = document.getElementById("storeNote").value.trim();
  if (!name) {
    toast("ストア名を入力してください", true);
    return;
  }
  try {
    await createStore(name, description);
    closeModal(dom.storeModal);
    toast("ストアを作成しました");
    await refreshStoresList();
  } catch (error) {
    console.error(error);
    toast("ストア作成に失敗しました", true);
  }
}

async function selectStore(storeName, focusChat = true) {
  const store = state.stores.find((item) => item.name === storeName);
  if (!store) return;
  state.activeStore = store;
  renderStores();
  dom.activeStoreTitle.textContent = store.displayName || simplifyName(store.name);
  dom.activeStoreMeta.textContent =
    store.description || "ファイルを追加して Gemini に質問しましょう。";
  dom.chatInput.disabled = false;
  dom.chatSubmit.disabled = false;
  dom.openUploadModal.disabled = false;
  dom.clearConversation.disabled = false;
  if (!state.conversations.has(store.name)) {
    state.conversations.set(store.name, []);
  }
  renderConversation();
  if (focusChat) {
    dom.chatInput.focus();
  }
  reloadStoreDetails(store.name);
}

async function reloadStoreDetails(storeName) {
  try {
    const files = await listFiles(storeName);
    const target = state.stores.find((store) => store.name === storeName);
    if (target) {
      target.files = files;
    }
    renderStores();
  } catch (error) {
    console.warn("Failed to load files", error);
  }
}

async function confirmDeleteStore(store) {
  if (!window.confirm(`${store.displayName || store.name} を削除しますか？`)) {
    return;
  }
  try {
    await deleteStore(store.name);
    toast("ストアを削除しました");
    if (state.activeStore && state.activeStore.name === store.name) {
      state.activeStore = null;
      dom.activeStoreTitle.textContent = "ストアが選択されていません";
      dom.activeStoreMeta.textContent =
        "左のリストからストアを選ぶか、新しく作成してください。";
      dom.chatInput.value = "";
      dom.chatInput.disabled = true;
      dom.chatSubmit.disabled = true;
      dom.openUploadModal.disabled = true;
      dom.clearConversation.disabled = true;
      dom.chatStream.innerHTML = "";
    }
    await refreshStoresList();
  } catch (error) {
    console.error(error);
    toast("ストア削除に失敗しました", true);
  }
}

function autoResizeInput(event) {
  const el = event.target;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}

async function handleUploadFile(event) {
  event.preventDefault();
  if (!state.activeStore) {
    toast("先にストアを選択してください", true);
    return;
  }
  const fileInput = document.getElementById("uploadFile");
  const file = fileInput.files?.[0];
  if (!file) {
    toast("ファイルを選択してください", true);
    return;
  }
  try {
    await uploadFileToStore(state.activeStore.name, file, {
      displayName: document.getElementById("uploadDisplayName").value.trim(),
    });
    toast("ファイルをアップロードしました");
    closeModal(dom.uploadModal);
    await reloadStoreDetails(state.activeStore.name);
  } catch (error) {
    console.error(error);
    toast("アップロードに失敗しました", true);
  }
}

function handleFilePreview() {
  const fileInput = document.getElementById("uploadFile");
  const file = fileInput.files?.[0];
  const label = document.getElementById("uploadLabel");
  if (file) {
    label.textContent = `${file.name} (${formatBytes(file.size)})`;
  } else {
    label.textContent = "ファイルを選択またはドロップ (PDF / TXT / MD など)";
  }
}

async function handleChatSubmit(event) {
  event.preventDefault();
  if (!state.activeStore || state.pendingChat) return;
  const question = dom.chatInput.value.trim();
  if (!question) return;
  dom.chatInput.value = "";
  autoResizeInput({ target: dom.chatInput });

  const convo = state.conversations.get(state.activeStore.name) || [];
  const userMessage = { role: "user", text: question, ts: Date.now() };
  convo.push(userMessage);
  renderConversation();

  try {
    state.pendingChat = true;
    setChatSubmitting(true);
    const answer = await askGemini(state.activeStore.name, convo);
    convo.push({ role: "model", ...answer, ts: Date.now() });
    state.conversations.set(state.activeStore.name, convo);
    renderConversation();
  } catch (error) {
    console.error(error);
    convo.push({
      role: "model",
      text: "エラーが発生しました。API 設定とストアを確認してください。",
      error: true,
      ts: Date.now(),
    });
    renderConversation();
  } finally {
    state.pendingChat = false;
    setChatSubmitting(false);
  }
}

function setChatSubmitting(submitting) {
  dom.chatSubmit.disabled = submitting;
  dom.chatSubmit.textContent = submitting ? "送信中..." : "送信";
}

function renderConversation() {
  dom.chatStream.innerHTML = "";
  if (!state.activeStore) return;
  const convo = state.conversations.get(state.activeStore.name) || [];
  for (const message of convo) {
    const node = dom.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(message.role === "user" ? "user" : "model");
    node.querySelector(".bubble-text").innerHTML = renderMarkdown(message.text || "");
    if (message.citations?.length) {
      const citationsNode = node.querySelector(".citations");
      for (const cite of message.citations) {
        const link = document.createElement("a");
        link.href = cite.uri || "#";
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = cite.title || cite.uri || "引用";
        citationsNode.appendChild(link);
      }
    }
    dom.chatStream.appendChild(node);
  }
  dom.chatStream.scrollTop = dom.chatStream.scrollHeight;
}

function renderMarkdown(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = escaped
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br />");
  return `<p>${html}</p>`;
}

function toast(message, isError = false) {
  const node = dom.statusToast;
  if (!node) return;
  node.textContent = message;
  node.style.background = isError ? "#c0392b" : "#111";
  node.dataset.visible = "true";
  clearTimeout(node._timer);
  node._timer = setTimeout(() => {
    node.dataset.visible = "false";
  }, 2600);
}

function simplifyName(name) {
  if (!name) return "";
  return name.split("/").pop();
}

function formatBytes(bytes) {
  if (bytes === 0) return "0B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)}${units[i]}`;
}

async function listStores() {
  const { apiKey, projectId, location } = state.config;
  const url = `${API_BASE}/projects/${encodeURIComponent(
    projectId
  )}/locations/${encodeURIComponent(location)}/fileStores?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch stores");
  const data = await res.json();
  const stores = data.fileStores || [];
  for (const store of stores) {
    try {
      store.files = await listFiles(store.name);
    } catch (error) {
      console.warn("Failed to load files", error);
    }
  }
  return stores;
}

async function createStore(displayName, description) {
  const { apiKey, projectId, location } = state.config;
  const url = `${API_BASE}/projects/${encodeURIComponent(
    projectId
  )}/locations/${encodeURIComponent(location)}/fileStores?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName, description }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

async function deleteStore(storeName) {
  const { apiKey } = state.config;
  const url = `${API_BASE}/${storeName}?key=${apiKey}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete store");
}

async function listFiles(storeName) {
  const { apiKey } = state.config;
  const url = `${API_BASE}/${storeName}/files?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch files");
  const data = await res.json();
  return data.files || [];
}

async function uploadFileToStore(storeName, file, { displayName }) {
  const { apiKey } = state.config;
  const form = new FormData();
  form.append("file", file, file.name);
  if (displayName) {
    form.append("displayName", displayName);
  }
  form.append("mimeType", file.type || "application/octet-stream");
  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}&fileStore=${encodeURIComponent(
    storeName
  )}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

async function askGemini(storeName, conversation) {
  const { apiKey } = state.config;
  const contents = conversation.map((message) => ({
    role: message.role === "user" ? "user" : "model",
    parts: [{ text: message.text }],
  }));
  const payload = {
    contents,
    tools: [{ fileSearch: {} }],
    toolConfig: {
      fileSearch: {
        fileStoreNames: [storeName],
        maxResults: 8,
      },
    },
    generationConfig: {
      temperature: 0.2,
    },
  };
  const url = `${API_BASE}/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts
    ?.map((part) => part.text || part.inlineData?.data || "")
    .join("\n")
    .trim();
  const citations = [];
  const metadata = candidate?.groundingMetadata?.supportingDocuments || [];
  for (const doc of metadata) {
    citations.push({
      title: doc.title || simplifyName(doc.id),
      uri: doc.uri,
    });
  }
  return {
    text: text || "回答を取得できませんでした。クエリやストアを確認してください。",
    citations,
  };
}
