import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    const { fileId, mode = "auto", exportMime } = await req.json();
    const token = req.headers.authorization?.split(" ")[1];
    if (!fileId || !token) {
      return res.status(400).json({ error: "Missing fileId or Authorization" });
    }

    // Google Drive API のURLを自動選択
    let url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    if (mode === "export") {
      const mime = exportMime || "application/pdf";
      url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(mime)}`;
    }

    // Google Driveからバイナリ取得
    const driveRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!driveRes.ok) {
      const text = await driveRes.text();
      throw new Error(`Drive API Error: ${text}`);
    }

    const buffer = Buffer.from(await driveRes.arrayBuffer());
    const base64 = buffer.toString("base64");

    // ファイル名を取得（省略時はfileId）
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const meta = metaRes.ok ? await metaRes.json() : { name: fileId };

    return res.status(200).json({
      name: meta.name,
      mimeType: meta.mimeType,
      size: meta.size,
      base64,
    });
  } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
  }
}
