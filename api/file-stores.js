const { getFileSearchService, getSupabaseService } = require('../lib/serverContext');
const { hydrateAuthFromRequest } = require('../lib/serverState');

function firstValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function handler(req, res) {
  try {
    await hydrateAuthFromRequest(req);

    if (req.method === 'GET') {
      await handleGet(req, res);
      return;
    }

    if (req.method === 'POST') {
      await handlePost(req, res);
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    console.error('Error in /api/file-stores:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(req, res) {
  const fileSearch = await getFileSearchService();
  const supabase = getSupabaseService();
  const officeId = firstValue(req.query?.officeId);

  if (!fileSearch?.apiKey) {
    try {
      if (supabase.isConfigured() && officeId) {
        const records = await supabase.listOfficeFileStores(officeId);
        const fallbackStores = records.map((record) => ({
          name: record.geminiStoreName,
          displayName: record.displayName || record.geminiStoreName,
          description: record.description || null,
          createTime: record.createTime || record.createdAt || null,
        }));
        res.status(200).json({ stores: fallbackStores });
        return;
      }
    } catch (error) {
      console.error('Supabase fallback stores failed:', error?.message || error);
      res.status(502).json({ error: 'ファイルストアの取得に失敗しました。' });
      return;
    }

    res.status(200).json({ stores: [] });
    return;
  }

  let stores = [];
  try {
    stores = await fileSearch.listStores();
  } catch (error) {
    console.error('Gemini file store fetch failed:', error?.message || error);
    res.status(502).json({ error: error?.message || 'ファイルストアの取得に失敗しました。' });
    return;
  }

  if (supabase.isConfigured() && officeId) {
    try {
      stores = await supabase.decorateStoresForOffice(stores, officeId);
    } catch (error) {
      console.error('Supabase store decoration failed:', error?.message || error);
    }
  }

  res.status(200).json({ stores });
}

async function handlePost(req, res) {
  const fileSearch = await getFileSearchService();
  if (!fileSearch?.apiKey) {
    res.status(400).json({ error: 'ファイルストアを利用するには GOOGLE_API_KEY を設定してください。' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const displayName = String(body.displayName || body.name || '').trim();

  if (!displayName) {
    res.status(400).json({ error: 'ストア名を入力してください。' });
    return;
  }

  const store = await fileSearch.createStore(displayName);

  const supabase = getSupabaseService();
  if (supabase.isConfigured()) {
    const session = body.session || {};
    try {
      if (session.officeId && session.staffId) {
        await supabase.recordFileStore({
          organizationId: session.organizationId || null,
          officeId: session.officeId,
          staffId: session.staffId,
          geminiStoreName: store.name,
          displayName: store.displayName || displayName,
        });
      }
    } catch (error) {
      console.error('Supabase store record error:', error?.message || error);
    }
  }

  res.status(201).json({ store });
}

module.exports = handler;
module.exports.default = handler;
