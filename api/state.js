const { ensureKnowledge, getFileSearchService } = require('../lib/serverContext');

async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const knowledge = await ensureKnowledge();
    const hasApiKey = Boolean(knowledge?.apiKey);
    const ready = Boolean(knowledge?.isReady);
    const documents = typeof knowledge?.listDocuments === 'function' ? knowledge.listDocuments() : [];
    let fileSearchReady = false;

    try {
      const fileSearch = await getFileSearchService();
      fileSearchReady = Boolean(fileSearch?.apiKey);
    } catch (error) {
      console.error('File search readiness check failed:', error?.message || error);
      fileSearchReady = false;
    }

    res.status(200).json({
      ready,
      error: knowledge?.error ? String(knowledge.error.message || knowledge.error) : null,
      documents,
      hasApiKey,
      fileSearchReady,
    });
  } catch (error) {
    console.error('Error in /api/state:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

module.exports = handler;
module.exports.default = handler;
