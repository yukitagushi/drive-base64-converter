import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import {
  buildGuestSessionPayload,
  buildSessionPayload,
  getSupabaseBearerToken,
  resolveStaffContext,
  resolveUserFromToken,
} from '../lib/api-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch (error: any) {
    console.error('Supabase admin init error:', error);
    res.status(200).json(buildGuestSessionPayload());
    return;
  }

  const token = getSupabaseBearerToken(req);
  if (!token) {
    res.status(200).json(buildGuestSessionPayload());
    return;
  }

  try {
    const user = await resolveUserFromToken(admin, token);
    const staff = await resolveStaffContext(admin, { userId: user.id, email: user.email });
    if (!staff) {
      res.status(200).json(buildGuestSessionPayload());
      return;
    }
    const payload = await buildSessionPayload(admin, staff);
    res.status(200).json(payload);
  } catch (error: any) {
    console.error('Error in /api/session:', error);
    res.status(401).json({ error: error?.message || 'セッション情報の取得に失敗しました。' });
  }
}
