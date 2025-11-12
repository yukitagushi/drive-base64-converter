import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAdmin } from './supabaseAdmin';

const DEFAULT_SIZE_LIMIT = 60 * 1024 * 1024; // 60MB

interface EnsureBucketOptions {
  admin?: SupabaseClient;
  bucket: string;
  sizeLimitBytes?: number;
  public?: boolean;
}

function isNotFoundError(error: { message?: string } | null): boolean {
  if (!error?.message) {
    return false;
  }
  return /not\s+found/i.test(error.message) || /does not exist/i.test(error.message);
}

export async function ensureStorageBucket(options: EnsureBucketOptions): Promise<void> {
  const { bucket, admin, public: isPublic = false } = options;
  const sizeLimit = options.sizeLimitBytes ?? DEFAULT_SIZE_LIMIT;

  if (!bucket) {
    throw new Error('Bucket 名が指定されていません。');
  }

  const client = admin ?? getSupabaseAdmin();

  const { data, error } = await client.storage.getBucket(bucket);
  if (data) {
    return;
  }

  if (error && !isNotFoundError(error)) {
    throw new Error(error.message || 'Supabase ストレージの取得に失敗しました。');
  }

  const sizeLimitString = Number.isFinite(sizeLimit) ? String(Math.floor(sizeLimit)) : undefined;
  const { error: createError } = await client.storage.createBucket(bucket, {
    public: isPublic,
    fileSizeLimit: sizeLimitString,
  });

  if (createError) {
    throw new Error(createError.message || 'Supabase ストレージバケットの作成に失敗しました。');
  }
}
