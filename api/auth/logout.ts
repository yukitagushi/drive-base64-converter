import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildAuthPayload, buildGuestSessionPayload, getSupabaseBearerToken } from '../../lib/api-auth';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    let admin;
    try {
      admin = getSupabaseAdmin();
    } catch (error: any) {
      console.error('Supabase admin init error:', error);
      res
        .status(200)
        .json({ auth: buildAuthPayload({ user: null, staff: null }), session: buildGuestSessionPayload() });
      return;
    }

    const token = getSupabaseBearerToken(req);
    if (token) {
      try {
        const url = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/logout` : null;
        const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
        if (url && apiKey) {
          await fetch(url, {
            method: 'POST',
            headers: {
              apikey: apiKey,
              Authorization: `Bearer ${token}`,
            },
          });
        }
      } catch (error: any) {
        console.error('Supabase signOut error:', error?.message || error);
      }
    }

    res.status(200).json({ auth: buildAuthPayload({ user: null, staff: null }), session: buildGuestSessionPayload() });
  } catch (error: any) {
    console.error('Error in /api/auth/logout:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}
