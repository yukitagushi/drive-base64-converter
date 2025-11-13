const { getSupabaseService } = require('../../lib/serverContext');
const {
  hydrateAuthFromRequest,
  setAuthContext,
  clearAuthContext,
  issueSessionCookie,
  clearSessionCookie,
  buildAuthPayload,
  buildSessionPayload,
  resetSessionAfterLogout,
} = require('../../lib/serverState');

function parseBody(req) {
  if (!req || !req.body) {
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

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  await hydrateAuthFromRequest(req);
  const supabase = getSupabaseService();
  let payload = {};
  try {
    payload = parseBody(req);
  } catch (error) {
    res.status(400).json({ error: error?.message || 'JSON 形式で送信してください。' });
    return;
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';

  if (!email || !password) {
    res.status(400).json({ error: 'メールアドレスとパスワードを入力してください。' });
    return;
  }

  try {
    const result = await supabase.signInWithPassword({ email, password });
    if (!result || !result.staff) {
      throw new Error('スタッフ情報が見つかりません。管理者にお問い合わせください。');
    }

    const user = {
      id: result.user?.id || result.staff.userId || null,
      email: result.user?.email || email,
      displayName:
        result.user?.user_metadata?.full_name ||
        result.user?.user_metadata?.display_name ||
        result.staff.displayName ||
        email,
    };

    const staff = {
      id: result.staff.id,
      email: result.staff.email,
      displayName: result.staff.displayName,
      officeId: result.staff.officeId,
      officeName: result.staff.officeName,
      organizationId: result.staff.organizationId,
      organizationName: result.staff.organizationName,
      role: result.staff.role,
    };

    const tokens = result.session
      ? {
          accessToken: result.session.access_token,
          refreshToken: result.session.refresh_token || null,
          expiresIn: result.session.expires_in || null,
          tokenType: result.session.token_type || 'bearer',
        }
      : null;

    setAuthContext({ user, staff, tokens });

    if (supabase.isConfigured() && staff.id) {
      supabase
        .recordAuthEvent({ staffId: staff.id, type: 'login' })
        .catch((error) => console.error('Supabase auth event error:', error?.message || error));
    }

    const [authPayload, sessionPayload] = await Promise.all([
      buildAuthPayload(),
      buildSessionPayload(),
    ]);

    issueSessionCookie(res, { user, staff, tokens });
    res.status(200).json({ auth: authPayload, session: sessionPayload });
  } catch (error) {
    console.error('Login error:', error?.message || error);
    clearAuthContext();
    await resetSessionAfterLogout();
    clearSessionCookie(res);
    res.status(400).json({ error: error?.message || 'ログインに失敗しました。' });
  }
}

module.exports = handler;
module.exports.default = handler;
