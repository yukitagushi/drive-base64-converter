// api/convert.js — Node 18+ (Vercel)
// 役割：Driveファイルを取得（必要なら export）、multipart/form-data で OpenAI /v1/files へ代理アップロード。
// 備考：req.body が未パースの環境でも動くように自前で JSON を読取り。
//       accessToken 未指定なら GOOGLE_* + REFRESH_TOKEN で自動取得に挑戦。

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    // --- Body 安全読取（obj でも string でも stream でもOK）---
    const body = await readJsonBody(req);
    const {
      fileId,
      accessToken,              // 任意：クライアント渡しを優先
      exportMime,               // Docs/Sheets/Slides をエクスポートしたい時に指定
      filename,                 // 任意：未指定なら Drive の name
      purpose = 'assistants',   // OpenAI files の purpose
      returnBase64 = false
    } = body || {};

    if (!fileId) {
      return res.status(400).json({ error: 'missing_params', detail: 'fileId' });
    }

    // --- 1) アクセストークン準備（クライアント優先 → 失敗なら refresh）---
    const token = await ensureAccessToken(accessToken);
    if (!token) {
      return res.status(401).json({ error: 'missing_access_token' });
    }

    // --- 2) メタ取得（name / mimeType を拾う）---
    let driveName = filename || null;
    let driveMime = null;
    try {
      const meta = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (meta.ok) {
        const m = await meta.json();
        driveName = driveName || m.name;
        driveMime = m.mimeType || null;
      }
    } catch { /* ignore meta errors */ }

    // --- 3) 実体取得 ---
    const driveUrl = exportMime
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;

    const fileResp = await fetch(driveUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (fileResp.status === 401) {
      return res.status(401).json({ error: 'drive_error', detail: await fileResp.text() });
    }
    if (!fileResp.ok) {
      return res.status(fileResp.status).json({ error: 'drive_error', detail: await fileResp.text() });
    }

    const ab = await fileResp.arrayBuffer();
    const buf = Buffer.from(ab);
    const mimeType =
      exportMime ||
      fileResp.headers.get('content-type') ||
      driveMime ||
      'application/octet-stream';

    const safeName = (driveName || `drive-${fileId}${extFromMime(mimeType)}`)
      .replace(/[^\w.\-]/g, '_');

    // --- 4) OpenAI へ multipart/form-data で代理アップロード ---
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'server_misconfig', detail: 'OPENAI_API_KEY not set' });
    }

    const form = new FormData();
    form.append('purpose', purpose);
    // Node 18+ は Blob/FormData をサポート（undici）
    form.append('file', new Blob([buf], { type: mimeType }), safeName);

    const oResp = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });

    const oText = await oResp.text();
    if (!oResp.ok) {
      return res.status(oResp.status).json({ error: 'openai_error', detail: oText });
    }

    const openai = JSON.parse(oText);
    return res.status(200).json({
      ok: true,
      name: safeName,
      mimeType,
      size: buf.length,
      openaiFileId: openai.id,
      openaiResponse: openai,
      ...(returnBase64 ? { base64: buf.toString('base64') } : {})
    });

  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String(e) });
  }

  // ===== Helpers =====

  // req.body が未パース/文字列/ストリームのいずれでも JSON を返す
  async function readJsonBody(req) {
    if (req && typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
      return req.body;
    }
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  // クライアント渡しが無ければ、環境変数の refresh_token で取得
  async function ensureAccessToken(tokenFromClient) {
    if (tokenFromClient && typeof tokenFromClient === 'string' && tokenFromClient.length > 20) {
      return tokenFromClient;
    }
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: GOOGLE_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.access_token || null;
  }

  function extFromMime(m) {
    const map = {
      'application/pdf': '.pdf',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'text/plain': '.txt',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
    };
    return map[m] || '';
  }
};

