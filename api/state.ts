export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    res.status(200).json({ ok: true, time: new Date().toISOString() });
  } catch (error: any) {
    console.error('Error in /api/state:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}
