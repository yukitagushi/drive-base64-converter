import type { VercelRequest, VercelResponse } from '@vercel/node';

import { GeminiApiError, analyzeFileWithGemini, analyzeInlineMediaWithGemini } from '../../lib/gemini';
import { getSupabaseBearerToken, resolveStaffForRequest } from '../../lib/api-auth';
import { getSupabaseClientWithToken } from '../../lib/supabaseClient';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';

function applyCors(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string | undefined) || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
}

function respond(res: VercelResponse, status: number, payload: Record<string, any>) {
  res.status(status).json({ source: 'api', status, ...payload });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,OPTIONS');
    respond(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    const token = getSupabaseBearerToken(req);
    if (!token) {
      respond(res, 401, { error: '認証が必要です。' });
      return;
    }

    const admin = getSupabaseAdmin();
    const staff = await resolveStaffForRequest(admin, req);
    if (!staff?.officeId) {
      respond(res, 403, { error: 'スタッフ情報が見つかりません。' });
      return;
    }

    const payload = await readJsonBody(req);
    const fileStoreIdRaw = payload.fileStoreId ?? payload.file_store_id;
    const fileIdRaw = payload.fileId ?? payload.id;
    const geminiFileNameRaw = payload.geminiFileName ?? payload.gemini_file_name;
    const promptRaw = payload.prompt ?? payload.query;
    const mimeTypeRaw = payload.mimeType ?? payload.mime_type;

    const fileStoreId = fileStoreIdRaw ? String(fileStoreIdRaw).trim() : '';
    const fileId = fileIdRaw ? String(fileIdRaw).trim() : '';
    const geminiFileName = geminiFileNameRaw ? String(geminiFileNameRaw).trim() : '';
    const prompt = promptRaw ? String(promptRaw).trim() : '';
    const mimeType = mimeTypeRaw ? String(mimeTypeRaw).trim() : '';

    if (!fileId && !geminiFileName) {
      respond(res, 400, { error: 'fileId または geminiFileName を指定してください。' });
      return;
    }

    const supabase = getSupabaseClientWithToken(token);

    let fileRow: any = null;
    if (fileId) {
      const { data, error } = await supabase
        .from('file_store_files')
        .select('id, file_store_id, gemini_file_name, mime_type, display_name')
        .eq('id', fileId)
        .maybeSingle();
      if (error) {
        throw new Error(error.message);
      }
      fileRow = data;
    }

    if (!fileRow && geminiFileName) {
      const { data, error } = await supabase
        .from('file_store_files')
        .select('id, file_store_id, gemini_file_name, mime_type, display_name')
        .eq('gemini_file_name', geminiFileName)
        .maybeSingle();
      if (error) {
        throw new Error(error.message);
      }
      fileRow = data;
    }

    if (!fileRow) {
      respond(res, 404, { error: '指定したファイルが見つかりません。' });
      return;
    }

    if (fileStoreId && fileRow.file_store_id && fileRow.file_store_id !== fileStoreId) {
      respond(res, 403, { error: '指定したファイルはこのストアに属していません。' });
      return;
    }

    const { data: storeRow, error: storeError } = await admin
      .from('file_stores')
      .select('office_id')
      .eq('id', fileRow.file_store_id)
      .maybeSingle();
    if (storeError) {
      throw new Error(storeError.message);
    }
    if (!storeRow || (storeRow.office_id && storeRow.office_id !== staff.officeId)) {
      respond(res, 403, { error: 'このファイルにはアクセスできません。' });
      return;
    }

    const requestPrompt = prompt || 'メディアの内容を要約し、重要なポイントと推奨アクションを日本語で示してください。';
    const resolvedMime = mimeType || fileRow.mime_type || 'application/octet-stream';

    // File Search store paths (fileSearchStores/...) cannot be used as fileUri.
    // Try to download from Supabase Storage and analyze inline instead.
    const isFileSearchPath = String(fileRow.gemini_file_name || '').startsWith('fileSearchStores/');

    let analysis;
    if (isFileSearchPath) {
      // Look up storage info for this file
      const { data: fileDetail } = await admin
        .from('file_store_files')
        .select('storage_bucket, storage_path')
        .eq('id', fileRow.id)
        .maybeSingle();

      const bucket = fileDetail?.storage_bucket || 'gemini-upload-cache';
      const storagePath = fileDetail?.storage_path || '';

      if (storagePath) {
        const { data: blob, error: dlError } = await admin.storage.from(bucket).download(storagePath);
        if (dlError || !blob) {
          respond(res, 400, { error: `ファイルのダウンロードに失敗しました: ${dlError?.message || '不明なエラー'}` });
          return;
        }
        const arrayBuf = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        analysis = await analyzeInlineMediaWithGemini({
          buffer,
          mimeType: resolvedMime,
          prompt: requestPrompt,
        });
      } else {
        respond(res, 400, { error: 'ストレージパスが見つかりません。ファイルを再アップロードしてください。' });
        return;
      }
    } else {
      analysis = await analyzeFileWithGemini({
        geminiFileName: fileRow.gemini_file_name,
        prompt: requestPrompt,
        mimeType: resolvedMime,
      });
    }

    respond(res, 200, {
      result: {
        text: analysis.text,
        model: analysis.model,
        candidates: analysis.candidates,
        usage: analysis.usage,
      },
    });
  } catch (error: any) {
    if (error instanceof GeminiApiError) {
      const status = error.status ?? 500;
      res.status(status).json({
        source: 'gemini',
        status,
        error: error.message,
        debugId: error.debugId ?? null,
      });
      return;
    }
    console.error('Error in /api/media/analyze:', error?.message || error);
    respond(res, 500, { error: error?.message || 'ファイル分析に失敗しました。' });
  }
}

async function readJsonBody(req: VercelRequest): Promise<Record<string, any>> {
  const existing = (req as any).body;
  if (existing && typeof existing === 'object') {
    return existing;
  }
  if (existing && typeof existing === 'string') {
    try {
      return JSON.parse(existing);
    } catch (error) {
      throw new Error('JSON の解析に失敗しました。');
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('JSON の解析に失敗しました。');
  }
}
