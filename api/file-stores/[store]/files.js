const { getFileSearchService, getSupabaseService } = require('../../../lib/serverContext');
const { hydrateAuthFromRequest } = require('../../../lib/serverState');

function firstValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function handler(req, res) {
  const storeName = firstValue(req.query?.store);

  if (!storeName) {
    res.status(400).json({ error: 'ストア名が指定されていません。' });
    return;
  }

  try {
    await hydrateAuthFromRequest(req);

    if (req.method === 'GET') {
      await handleGet(storeName, res);
      return;
    }

    if (req.method === 'POST') {
      await handlePost(storeName, req, res);
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    console.error(`Error in /api/file-stores/${storeName}/files:`, error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(storeName, res) {
  const fileSearch = await getFileSearchService();
  if (!fileSearch?.apiKey) {
    res.status(400).json({ error: 'ファイルストアを利用するには GOOGLE_API_KEY を設定してください。' });
    return;
  }

  const files = await fileSearch.listFiles(storeName);
  res.status(200).json({ files });
}

async function handlePost(storeName, req, res) {
  const fileSearch = await getFileSearchService();
  if (!fileSearch?.apiKey) {
    res.status(400).json({ error: 'ファイルストアを利用するには GOOGLE_API_KEY を設定してください。' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  const payload = {
    storeName,
    fileName: body.fileName,
    mimeType: body.mimeType,
    data: body.data,
    description: body.description,
  };

  const file = await fileSearch.uploadFile(payload);
  const derivedDescription = file?.analysis?.summary || body.description;
  const derivedMimeType = file?.analysis?.originalMimeType || file?.mimeType || body.mimeType;

  const supabase = getSupabaseService();
  if (supabase.isConfigured()) {
    const session = body.session || {};
    try {
      const record = await supabase.findFileStoreRecord(storeName);
      if (record && session.staffId) {
        await supabase.recordFileUpload({
          fileStoreId: record.id,
          staffId: session.staffId,
          geminiFileName: file.name,
          displayName: file.displayName || body.fileName,
          description: derivedDescription,
          sizeBytes: file.sizeBytes,
          mimeType: derivedMimeType,
        });
      }
    } catch (error) {
      console.error('Supabase upload log error:', error?.message || error);
    }
  }

  res.status(201).json({ file });
}

module.exports = handler;
module.exports.default = handler;
