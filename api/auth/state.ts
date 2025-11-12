import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildAuthPayload } from '../../lib/api-auth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const payload = buildAuthPayload({ user: null, staff: null });
    res.status(200).json(payload);
  } catch (error: any) {
    console.error('Error in /api/auth/state:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}
