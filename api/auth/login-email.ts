import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { buildAuthPayload, buildSessionPayload, resolveStaffContext } from '../../lib/api-auth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch (error: any) {
    console.error('Supabase admin init error:', error);
    res.status(500).json({ error: 'Supabase 管理クライアントの初期化に失敗しました。' });
    return;
  }

  let payload: any = {};
  try {
    if (typeof req.body === 'string') {
      payload = req.body ? JSON.parse(req.body) : {};
    } else if (req.body && typeof req.body === 'object') {
      payload = req.body;
    }
  } catch (error: any) {
    res.status(400).json({ error: 'JSON 形式で送信してください。' });
    return;
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';

  if (!email || !password) {
    res.status(400).json({ error: 'メールアドレスとパスワードは必須です。' });
    return;
  }

  try {
    const { data, error } = await admin.auth.signInWithPassword({ email, password });
    if (error) {
      const status = error.status || 401;
      res.status(status).json({ error: error.message || 'メールアドレスまたはパスワードが正しくありません。' });
      return;
    }

    const user = data?.user;
    const supabaseSession = data?.session || null;
    if (!user) {
      res.status(500).json({ error: 'ユーザー情報を取得できませんでした。' });
      return;
    }

    const staff = await resolveStaffContext(admin, { userId: user.id, email: user.email });
    if (!staff) {
      res.status(403).json({ error: 'スタッフ情報が見つかりません。管理者にお問い合わせください。' });
      return;
    }

    const auth = buildAuthPayload({ user, staff });
    const session = await buildSessionPayload(admin, staff);

    res.status(200).json({
      ok: true,
      userId: user.id,
      auth,
      session,
      supabaseSession: supabaseSession
        ? {
            accessToken: supabaseSession.access_token || null,
            refreshToken: supabaseSession.refresh_token || null,
            provider: supabaseSession.user?.app_metadata?.provider || 'email',
          }
        : null,
    });
  } catch (error: any) {
    console.error('Error in /api/auth/login-email:', error);
    res.status(500).json({ error: error?.message || 'ログイン処理に失敗しました。' });
  }
}
