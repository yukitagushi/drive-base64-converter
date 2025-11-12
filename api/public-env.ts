import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || null;
    const anonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || null;

    res.status(200).json({ supabaseUrl, anonKey });
  } catch (error: any) {
    console.error('Error in /api/public-env:', error);
    res
      .status(500)
      .json({ error: error?.message || 'Supabase 環境変数の取得に失敗しました。' });
  }
}
