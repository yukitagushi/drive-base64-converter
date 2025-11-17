import type { VercelRequest, VercelResponse } from '@vercel/node';
import { debugListGeminiModels } from '../lib/gemini';

function applyCors(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string | undefined) || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET,OPTIONS');
    res.status(405).json({ source: 'api', status: 405, error: 'Method Not Allowed' });
    return;
  }

  try {
    await debugListGeminiModels();
    res.status(200).json({
      source: 'api',
      status: 200,
      success: true,
      message: 'Gemini ListModels を実行しました。ログを確認してください。',
    });
  } catch (error: any) {
    console.error('/api/debug-gemini-models failed', error);
    res.status(500).json({
      source: 'api',
      status: 500,
      error: 'list_models_failed',
      message: error?.message || 'Gemini ListModels の呼び出しに失敗しました。',
    });
  }
}
