const fs = require('fs/promises');
const path = require('path');

const DEFAULT_CONTEXT_CHUNKS = 4;
const DEFAULT_MAX_CHARS = 900;
const DEFAULT_OVERLAP = 120;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta';

function buildModelPath(model) {
  const trimmed = String(model || '').trim();
  if (!trimmed) {
    throw new Error('Gemini モデル名が指定されていません。');
  }
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

class GeminiKnowledgeBase {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    this.baseDocumentPath = options.baseDocumentPath || path.join(__dirname, '..', 'data', 'transcript-ja.txt');
    this.userStorePath = options.userStorePath || path.join(__dirname, '..', 'data', 'user-notes.json');
    this.chatModel = options.chatModel || process.env.GEMINI_CHAT_MODEL || 'gemini-2.0-flash';
    this.embedModel = options.embedModel || process.env.GEMINI_EMBED_MODEL || 'text-embedding-004';
    this.contextChunkCount = Number(options.contextChunkCount || process.env.GEMINI_CONTEXT_CHUNKS || DEFAULT_CONTEXT_CHUNKS);
    this.maxChars = Number(options.maxChars || process.env.GEMINI_CHUNK_CHARS || DEFAULT_MAX_CHARS);
    this.overlap = Number(options.overlap || process.env.GEMINI_CHUNK_OVERLAP || DEFAULT_OVERLAP);

    this.documents = [];
    this.embeddings = [];
    this.isReady = false;
    this.error = null;
  }

  async init() {
    try {
      await this.reload();
      this.isReady = Boolean(this.apiKey && this.embeddings.length);
      this.error = null;
    } catch (err) {
      this.error = err;
      this.isReady = false;
      console.error('[GeminiKnowledgeBase] 初期化に失敗しました:', err);
    }
  }

  async reload() {
    this.documents = [];
    this.embeddings = [];

    const baseDocs = await this.#loadBaseDocument();
    const userDocs = await this.#loadUserDocuments();

    this.documents.push(...baseDocs, ...userDocs);

    if (!this.apiKey) {
      this.isReady = false;
      return;
    }

    for (const doc of this.documents) {
      const vector = await this.#embedText(doc.content);
      this.embeddings.push({ id: doc.id, vector });
    }

    this.isReady = Boolean(this.embeddings.length);
    this.error = null;
  }

  async addUserDocument({ title, content }) {
    const cleanTitle = (title || '').trim();
    const cleanContent = (content || '').trim();

    if (!cleanTitle || !cleanContent) {
      throw new Error('title と content は必須です');
    }

    const existing = await this.#readUserStore();
    const entry = {
      id: `user-${Date.now()}`,
      title: cleanTitle,
      content: cleanContent,
    };

    existing.push(entry);
    await fs.writeFile(this.userStorePath, JSON.stringify(existing, null, 2), 'utf8');
    await this.reload();

    return entry;
  }

  listDocuments() {
    return this.documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      source: doc.source,
      tokens: Math.ceil(doc.content.length / 3),
      preview: doc.content.slice(0, 160).replace(/\s+/g, ' '),
    }));
  }

  async chat({ query, history = [] }) {
    if (!this.apiKey) {
      const err = new Error('GOOGLE_API_KEY (または GEMINI_API_KEY) が設定されていません');
      this.error = err;
      throw err;
    }

    const cleanQuery = (query || '').trim();
    if (!cleanQuery) {
      throw new Error('クエリが空です');
    }

    if (!this.embeddings.length) {
      await this.reload();
      if (!this.embeddings.length) {
        const err = new Error('ナレッジベースが空です');
        this.error = err;
        throw err;
      }
    }

    const queryVector = await this.#embedText(cleanQuery);
    const scored = this.embeddings
      .map((item, index) => ({
        index,
        id: item.id,
        score: cosineSimilarity(queryVector, item.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.contextChunkCount);

    const contextDocs = scored.map(({ index, score }) => ({
      score,
      ...this.documents[index],
    }));

    const contextText = contextDocs
      .map((doc, i) => `### ソース${i + 1}: ${doc.title}\nスコア: ${doc.score.toFixed(3)}\n${doc.content.trim()}`)
      .join('\n\n');

    const systemPrompt = [
      'あなたは日本語で回答する AI ナレッジアシスタントです。',
      '以下のコンテキストのみを根拠にして、ユーザーの質問に回答してください。',
      '不明な場合は、分からないと率直に伝えてください。',
      '回答の最後に参照したソース番号を括弧で示してください (例: (ソース1, ソース3))。',
    ].join('\n');

    const conversation = [];
    for (const item of history) {
      if (!item || !item.role || !item.content) continue;
      const role = item.role === 'model' ? 'model' : item.role;
      conversation.push({
        role,
        parts: [{ text: String(item.content) }],
      });
    }

    conversation.push({
      role: 'user',
      parts: [{
        text: `${systemPrompt}\n\n# コンテキスト\n${contextText}\n\n# 質問\n${cleanQuery}`,
      }],
    });

    const modelPath = buildModelPath(this.chatModel);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelPath}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${modelPath}`,
          contents: conversation,
          generationConfig: {
            temperature: 0.3,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024,
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUAL', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS', threshold: 'BLOCK_NONE' },
          ],
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      const err = data.error?.message || 'Gemini API からエラーが返りました';
      this.error = new Error(err);
      throw this.error;
    }

    const answer = extractTextFromResponse(data);
    this.error = null;
    return {
      answer,
      context: contextDocs.map((doc) => ({
        id: doc.id,
        title: doc.title,
        score: doc.score,
      })),
    };
  }

  async #loadBaseDocument() {
    const text = await fs.readFile(this.baseDocumentPath, 'utf8');
    const chunks = chunkText(text, this.maxChars, this.overlap);
    return chunks.map((content, index) => ({
      id: `base-${index}`,
      title: `YouTube原稿 チャンク${index + 1}`,
      content,
      source: 'transcript',
    }));
  }

  async #loadUserDocuments() {
    const list = await this.#readUserStore();
    const docs = [];
    list.forEach((entry, docIndex) => {
      const chunks = chunkText(entry.content, this.maxChars, this.overlap);
      chunks.forEach((content, chunkIndex) => {
        docs.push({
          id: `${entry.id}-${chunkIndex}`,
          title: `${entry.title} チャンク${chunkIndex + 1}`,
          content,
          source: 'user',
        });
      });
    });
    return docs;
  }

  async #readUserStore() {
    try {
      const file = await fs.readFile(this.userStorePath, 'utf8');
      const parsed = JSON.parse(file);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => ({
          id: item.id,
          title: item.title,
          content: item.content,
        }));
      }
      return [];
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async #embedText(text) {
    const clean = text.replace(/\s+/g, ' ').trim();
    const body = {
      content: {
        parts: [{ text: clean.slice(0, 6000) }],
      },
    };

    const modelPath = buildModelPath(this.embedModel);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelPath}:embedContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${modelPath}`,
          ...body,
        }),
      }
    );

    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error?.message || 'Gemini API (埋め込み) からエラーが返りました';
      throw new Error(err);
    }

    if (!data.embedding?.values) {
      throw new Error('Gemini API から埋め込みベクトルを取得できませんでした');
    }

    return data.embedding.values;
  }
}

class GeminiFileSearchService {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  }

  setApiKey(apiKey) {
    if (apiKey) {
      this.apiKey = apiKey;
    }
  }

  async listStores() {
    const response = await this.#request(`${GEMINI_API_BASE}/fileStores`);
    const data = await response.json();
    if (!response.ok) {
      throw this.#createError(data, 'ファイルストアの取得に失敗しました');
    }
    return Array.isArray(data.fileStores) ? data.fileStores.map(normalizeStore) : [];
  }

  async createStore(displayName) {
    if (!displayName || !displayName.trim()) {
      throw new Error('ストア名を入力してください');
    }

    const response = await this.#request(`${GEMINI_API_BASE}/fileStores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: displayName.trim() }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw this.#createError(data, 'ファイルストアの作成に失敗しました');
    }
    return normalizeStore(data);
  }

  async listFiles(storeName) {
    if (!storeName) {
      throw new Error('ストア名が指定されていません');
    }

    const pathName = encodePath(storeName);
    const response = await this.#request(`${GEMINI_API_BASE}/${pathName}/files`);
    const data = await response.json();
    if (!response.ok) {
      throw this.#createError(data, 'ファイル一覧の取得に失敗しました');
    }
    return Array.isArray(data.files) ? data.files.map(normalizeFile) : [];
  }

  async uploadFile({ storeName, fileName, mimeType, data, description }) {
    if (!storeName) {
      throw new Error('アップロード先ストアが選択されていません');
    }
    if (!fileName) {
      throw new Error('ファイル名が空です');
    }
    if (!data) {
      throw new Error('ファイルデータが取得できませんでした');
    }

    const pathName = encodePath(storeName);
    const buffer = Buffer.from(data, 'base64');
    const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
    const form = new FormData();

    const metadata = {
      displayName: fileName,
    };
    // Gemini rejects unknown metadata fields (e.g. "description"), so we only
    // send the display name and keep descriptive text in Supabase.

    form.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' })
    );
    form.append('file', blob, fileName);

    const response = await this.#request(
      `${GEMINI_UPLOAD_BASE}/${pathName}/files:upload?uploadType=multipart`,
      {
        method: 'POST',
        body: form,
      }
    );

    const result = await response.json();
    if (!response.ok) {
      throw this.#createError(result, 'ファイルのアップロードに失敗しました');
    }

    return normalizeFile(result.file || result);
  }

  async #request(url, options = {}) {
    if (!this.apiKey) {
      throw new Error('ファイルサーチを利用するには GOOGLE_API_KEY が必要です');
    }

    const hasQuery = url.includes('?');
    const finalUrl = `${url}${hasQuery ? '&' : '?'}key=${this.apiKey}`;
    return fetch(finalUrl, {
      ...options,
      headers: {
        ...(options.headers || {}),
      },
    });
  }

  #createError(data, fallback) {
    const message = data?.error?.message || fallback;
    const err = new Error(message);
    err.details = data?.error || null;
    return err;
  }
}

function chunkText(text, maxChars = DEFAULT_MAX_CHARS, overlap = DEFAULT_OVERLAP) {
  const normalized = text.replace(/\r\n/g, '\n');
  const sentences = normalized.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }

    if ((current + '\n\n' + sentence).length <= maxChars) {
      current += '\n\n' + sentence;
    } else {
      chunks.push(current);
      const overlapText = current.slice(-overlap);
      current = overlapText + '\n\n' + sentence;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length ? chunks : [normalized];
}

function cosineSimilarity(a, b) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function extractTextFromResponse(data) {
  const candidates = data.candidates || [];
  for (const candidate of candidates) {
    if (!candidate?.content?.parts) continue;
    const texts = candidate.content.parts
      .map((part) => part.text || '')
      .join('\n')
      .trim();
    if (texts) {
      return texts;
    }
  }
  return '';
}

function normalizeStore(entry = {}) {
  return {
    name: entry.name || '',
    displayName: entry.displayName || deriveDisplayName(entry.name),
    createTime: entry.createTime || null,
    updateTime: entry.updateTime || null,
    fileCount: Number(entry.fileCount ?? entry.file_count ?? 0),
    sizeBytes: Number(entry.sizeBytes ?? entry.size_bytes ?? 0),
  };
}

function normalizeFile(entry = {}) {
  return {
    name: entry.name || '',
    displayName: entry.displayName || deriveDisplayName(entry.name),
    mimeType: entry.mimeType || entry.mime_type || 'application/octet-stream',
    sizeBytes: Number(entry.sizeBytes ?? entry.size_bytes ?? 0),
    createTime: entry.createTime || null,
    updateTime: entry.updateTime || null,
  };
}

function deriveDisplayName(name = '') {
  if (!name) return '';
  const parts = String(name).split('/');
  return parts[parts.length - 1];
}

function encodePath(value) {
  return String(value)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

module.exports = {
  GeminiKnowledgeBase,
  GeminiFileSearchService,
  chunkText,
};
