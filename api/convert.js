import FormData from "form-data";

export default async function handler(req, res) {
  try {
    const { fileId, accessToken, exportMime, purpose } = req.body || {};
    if (!fileId || !accessToken) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'missing_params' }));
    }
    const url = exportMime
      ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const driveRes = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!driveRes.ok) {
      const detail = await driveRes.text();
      res.statusCode = driveRes.status;
      return res.end(JSON.stringify({ error: 'drive_error', detail }));
    }
    const buffer = Buffer.from(await driveRes.arrayBuffer());
    const form = new FormData();
    // default purpose if not provided
    form.append('purpose', purpose || 'assistants');
    form.append('file', buffer, {
      filename: `uploaded_file`,
      contentType: exportMime || driveRes.headers.get('content-type') || 'application/octet-stream',
    });
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: 'missing_openai_key' }));
    }
    const openaiRes = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        ...form.getHeaders(),
      },
      body: form,
    });
    const openaiText = await openaiRes.text();
    if (!openaiRes.ok) {
      res.statusCode = openaiRes.status;
      return res.end(JSON.stringify({ error: 'openai_error', detail: openaiText }));
    }
    res.setHeader('Content-Type', 'application/json');
    return res.end(openaiText);
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'server_error', detail: String(e) }));
  }
}
