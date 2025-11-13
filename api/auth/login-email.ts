const { getSupabaseService } = require('../../lib/serverContext');
const {
  setAuthContext,
  clearAuthContext,
  buildAuthPayload,
  buildSessionPayload,
  resetSessionAfterLogout,
} = require('../../lib/serverState');

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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const supabase = getSupabaseService();
  let payload: any = {};
  try {
    payload = parseBody(req);
  } catch (error: any) {
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
    if (!result?.staff) {
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
        .catch((error: any) => console.error('Supabase auth event error:', error?.message || error));
    }

    const [authPayload, sessionPayload] = await Promise.all([
      buildAuthPayload(),
      buildSessionPayload(),
    ]);

    res.status(200).json({ auth: authPayload, session: sessionPayload });
  } catch (error: any) {
    console.error('Login error:', error?.message || error);
    clearAuthContext();
    await resetSessionAfterLogout();
    res.status(400).json({ error: error?.message || 'ログインに失敗しました。' });
  }
}
