const { ensureKnowledge } = require('../lib/serverContext');

export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'GET') {
      await handleGet(res);
      return;
    }

    if (req.method === 'POST') {
      await handlePost(req, res);
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error: any) {
    console.error('Error in /api/documents:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(res: any) {
  const knowledge = await ensureKnowledge();
  const documents = typeof knowledge?.listDocuments === 'function' ? knowledge.listDocuments() : [];
  res.status(200).json({ documents });
}

async function handlePost(req: any, res: any) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const title = body.title;
  const content = body.content;

  const knowledge = await ensureKnowledge();

  try {
    const entry = await knowledge.addUserDocument({ title, content });
    const documents = typeof knowledge?.listDocuments === 'function' ? knowledge.listDocuments() : [];
    res.status(201).json({ document: entry, documents });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'ドキュメントの追加に失敗しました' });
  }
}
