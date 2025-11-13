const { getFileSearchService, getSupabaseService } = require('../lib/serverContext');

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export default async function handler(req: any, res: any) {
  try {
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
  } catch (error: any) {
    console.error('Error in /api/file-stores:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(req: any, res: any) {
  const fileSearch = await getFileSearchService();
  if (!fileSearch?.apiKey) {
    res.status(400).json({ error: 'ファイルストアを利用するには GOOGLE_API_KEY を設定してください。' });
    return;
  }

  let stores = await fileSearch.listStores();

  const supabase = getSupabaseService();
  const officeId = firstValue(req.query?.officeId);

  if (supabase.isConfigured() && officeId) {
    try {
      stores = await supabase.decorateStoresForOffice(stores, officeId);
    } catch (error: any) {
      console.error('Supabase store decoration failed:', error?.message || error);
    }
  }

  res.status(200).json({ stores });
}

async function handlePost(req: any, res: any) {
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
    } catch (error: any) {
      console.error('Supabase store record error:', error?.message || error);
    }
  }

  res.status(201).json({ store });
}
