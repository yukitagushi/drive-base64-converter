const { ensureKnowledge, getSupabaseService, getFileSearchService } = require('../lib/serverContext');
const { hydrateAuthFromRequest } = require('../lib/serverState');

function normalizeHistory(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => ({
      role: item?.role === 'model' ? 'model' : item?.role === 'assistant' ? 'model' : 'user',
      content: typeof item?.content === 'string' ? item.content : '',
    }))
    .filter((item) => item.content);
}

function generateThreadTitle(text) {
  if (!text) {
    return '新しい質問';
  }
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '新しい質問';
  }
  const snippet = normalized.slice(0, 28);
  return normalized.length > 28 ? `${snippet}…` : snippet;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    await hydrateAuthFromRequest(req);

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const query = String(body.query || '').trim();

    if (!query) {
      res.status(400).json({ error: 'クエリが空です' });
      return;
    }

    const knowledge = await ensureKnowledge();
    const fileSearch = await getFileSearchService();
    const supabase = getSupabaseService();

    const history = normalizeHistory(body.history);

    const requestedStores = Array.isArray(body.stores)
      ? body.stores.map((name) => String(name || '').trim()).filter(Boolean)
      : [];

    const sessionInput = body.session || {};
    const session = {
      organizationId: sessionInput.organizationId || null,
      officeId: sessionInput.officeId || null,
      staffId: sessionInput.staffId || null,
      threadId: sessionInput.threadId || null,
      supabaseConfigured: supabase.isConfigured(),
    };

    let officeStoreNames = [];
    if (supabase.isConfigured() && session.officeId) {
      try {
        const officeStores = await supabase.listOfficeFileStores(session.officeId);
        officeStoreNames = officeStores.map((store) => store.geminiStoreName).filter(Boolean);
      } catch (error) {
        console.error('Supabase office store lookup failed:', error?.message || error);
      }
    }

    const targetStoreNames = requestedStores.length ? requestedStores : officeStoreNames;

    let result = null;
    let source = 'local';

    if (fileSearch?.apiKey && targetStoreNames.length) {
      try {
        const fsResult = await fileSearch.generateAnswer({
          query,
          history,
          storeNames: targetStoreNames,
          systemPrompt:
            'アップロード済みのドキュメントを参照しながら、質問に対して事実に基づいた回答を日本語で作成してください。根拠が不十分な場合はその旨を伝えてください。',
        });

        if (fsResult?.answer) {
          source = 'file-search';
          const context = (fsResult.citations || []).map((citation, index) => ({
            id: citation.sourceId || `file-search-${index + 1}`,
            title: citation.sourceTitle || citation.sourceId || `関連ドキュメント ${index + 1}`,
            snippet: citation.chunkText || '',
          }));
          result = {
            answer: fsResult.answer,
            context,
            raw: fsResult.raw,
          };
        }
      } catch (error) {
        console.error('Gemini File Search chat error:', error?.message || error);
      }
    }

    if (!result) {
      const fallback = await knowledge.chat({ query, history });
      result = fallback;
      source = 'local';
    }

    let thread = null;
    let threads;

    if (supabase.isConfigured()) {
      if (!session.officeId || !session.staffId) {
        res.status(403).json({ error: 'チャットを利用するにはログインしてください。' });
        return;
      }

      try {
        if (!session.threadId) {
          const created = await supabase.ensureThread({
            officeId: session.officeId,
            staffId: session.staffId,
            title: generateThreadTitle(query),
          });
          if (created?.id) {
            session.threadId = created.id;
            thread = created;
          }
        } else {
          thread = { id: session.threadId };
        }

        if (thread?.id) {
          await supabase.recordMessages({
            threadId: thread.id,
            staffId: session.staffId,
            userMessage: query,
            assistantMessage: result.answer,
            context: {
              source,
              items: result.context,
            },
          });
          threads = await supabase.listThreads({ officeId: session.officeId }).catch((error) => {
            console.error('Supabase thread list error:', error?.message || error);
            return [];
          });
        }
      } catch (error) {
        console.error('Supabase chat logging error:', error?.message || error);
      }
    }

    res.status(200).json({
      ...result,
      source,
      storeNames: targetStoreNames,
      thread,
      threads,
      session,
    });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(400).json({ error: error?.message || 'Gemini チャットの呼び出しに失敗しました' });
  }
}

module.exports = handler;
module.exports.default = handler;
