const { getSupabaseService } = require('../lib/serverContext');
const {
  buildSessionPayload,
  updateSessionState,
  buildAuthPayload,
  getSessionState,
  getAuthState,
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

export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'GET') {
      const payload = await buildSessionPayload();
      res.status(200).json(payload);
      return;
    }

    if (req.method === 'POST') {
      await handlePost(req, res);
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error: any) {
    console.error('Error in /api/session:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

async function handlePost(req: any, res: any) {
  const supabase = getSupabaseService();
  let body;
  try {
    body = parseBody(req);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'JSON 形式で送信してください。' });
    return;
  }
  const payload = body || {};
  const previousStaff = getSessionState().staffId;

  if (supabase.isConfigured() && !getAuthState().staff) {
    res.status(403).json({ error: '先にログインしてください。' });
    return;
  }

  const session = updateSessionState(payload);

  if (supabase.isConfigured()) {
    try {
      if (previousStaff && previousStaff !== session.staffId) {
        await supabase.recordAuthEvent({ staffId: previousStaff, type: 'logout' });
      }
      if (session.staffId && previousStaff !== session.staffId) {
        await supabase.recordAuthEvent({ staffId: session.staffId, type: 'login' });
      }
    } catch (error: any) {
      console.error('Supabase auth event error:', error?.message || error);
    }
  }

  const response = await buildSessionPayload();
  if (!response.supabaseConfigured) {
    const auth = await buildAuthPayload();
    res.status(200).json({ ...response, auth });
    return;
  }

  res.status(200).json(response);
}
