import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { buildAuthPayload, buildSessionPayload, resolveStaffContext, resolveUserFromToken } from '../../lib/api-auth';

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

  let body: any = {};
  if (typeof req.body === 'string') {
    try {
      body = req.body ? JSON.parse(req.body) : {};
    } catch (error: any) {
      res.status(400).json({ error: 'JSON 形式で送信してください。' });
      return;
    }
  } else if (req.body && typeof req.body === 'object') {
    body = req.body;
  }

  const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
  const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : null;
  const provider = typeof body.provider === 'string' ? body.provider : null;

  if (!accessToken) {
    res.status(400).json({ error: 'accessToken は必須です。' });
    return;
  }

  try {
    const user = await resolveUserFromToken(admin, accessToken);
    const staff = await resolveStaffContext(admin, { userId: user.id, email: user.email });

    if (!staff) {
      res.status(403).json({ error: 'スタッフ情報が見つかりません。管理者にお問い合わせください。' });
      return;
    }

    const auth = buildAuthPayload({ user, staff });
    const session = await buildSessionPayload(admin, staff);

    res.status(200).json({
      auth,
      session,
      supabaseSession: {
        accessToken,
        refreshToken,
        provider,
      },
    });
  } catch (error: any) {
    console.error('Error in /api/auth/oauth-session:', error);
    res.status(500).json({ error: error?.message || 'OAuth セッションの確立に失敗しました。' });
  }
}
