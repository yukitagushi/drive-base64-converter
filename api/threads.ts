const { getSupabaseService } = require('../lib/serverContext');
const {
  getAuthState,
  updateSessionState,
  buildSessionPayload,
} = require('../lib/serverState');

function parseBody(req: any) {
  if (!req?.body) {
    return {};
  }
  if (typeof req.body === 'string') {
    if (!req.body) return {};
    try {
      return JSON.parse(req.body);
    } catch (error) {
      throw new Error('JSON 形式で送信してください。');
    }
  }
  if (typeof req.body === 'object') {
    return req.body;
  }
  return {};
}

function generateThreadTitle(text: string): string {
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
    console.error('Error in /api/threads:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(res: any) {
  const supabase = getSupabaseService();
  const auth = getAuthState();

  if (supabase.isConfigured() && !auth.staff) {
    res.status(403).json({ error: 'スレッドを閲覧するにはログインが必要です。' });
    return;
  }

  const payload = await buildSessionPayload();
  res.status(200).json(payload);
}

async function handlePost(req: any, res: any) {
  const supabase = getSupabaseService();
  if (supabase.isConfigured() && !getAuthState().staff) {
    res.status(403).json({ error: 'スレッドを作成するにはログインが必要です。' });
    return;
  }

  let body;
  try {
    body = parseBody(req);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'JSON 形式で送信してください。' });
    return;
  }

  const session = updateSessionState(body.session || {});
  if (!session.officeId || !session.staffId) {
    res.status(400).json({ error: '事業所とスタッフを選択してください。' });
    return;
  }

  try {
    const title = body.title || generateThreadTitle(body.query || '');
    const thread = await supabase.ensureThread({
      officeId: session.officeId,
      staffId: session.staffId,
      title,
    });
    updateSessionState({ threadId: thread?.id || null });

    const payload = await buildSessionPayload();
    res.status(201).json(payload);
  } catch (error: any) {
    console.error('Supabase thread create error:', error?.message || error);
    res.status(502).json({ error: 'スレッドの作成に失敗しました' });
  }
}
