// /api/convert.js
module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      // （必要なら）ブラウザ直叩き用のCORSプリフライト
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.statusCode = 204;
      return res.end();
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      res.statusCode = 405;
      return res.end('Method Not Allowed');
    }

    const body = await readJsonBody(req); // ★ここがポイント（req.json()は使わない）
    const { fileId, accessToken, exportMime } = body || {};
    if (!fileId || !accessToken) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'missing_params' }));
    }

    const url = exportMime
      ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const detail = await r.text();
      res.statusCode = r.status;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'drive_error', detail }));
    }

    const buf = Buffer.from(await r.arrayBuffer());
    const base64 = buf.toString('base64');

    res.setHeader('Content-Type', 'application/json');
    // （必要なら）フロント直叩き用のCORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(
      JSON.stringify({
        base64,
        name: `${fileId}`,
        mimeType: exportMime || r.headers.get('content-type') || 'application/octet-stream',
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'server_error', detail: String(e) }));
  }
};

// NodeのIncomingMessageからJSONを読むヘルパー
async function readJsonBody(req) {
  // Next.js API ルート経由だと req.body が既に入っていることもある
  if (req.body && typeof req.body === 'object') return req.body;

  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
