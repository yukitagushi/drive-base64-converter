const { hydrateAuthFromRequest, buildAuthPayload } = require('../../lib/serverState');

async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    await hydrateAuthFromRequest(req);
    const payload = await buildAuthPayload();
    res.status(200).json(payload);
  } catch (error) {
    console.error('Error in /api/auth/state:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

module.exports = handler;
module.exports.default = handler;
