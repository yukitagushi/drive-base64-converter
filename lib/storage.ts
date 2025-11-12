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
    // Bucket already exists. If a limit is configured and differs from what we
    // expect, attempt to relax it (some older buckets were provisioned with
    // very small limits which later block uploads).
    if (sizeLimit && Number.isFinite(sizeLimit)) {
      const desiredLimit = Math.max(0, Math.floor(sizeLimit));
      const currentLimit = typeof (data as any).file_size_limit === 'number'
        ? (data as any).file_size_limit
        : Number.parseInt(String((data as any).file_size_limit ?? ''), 10);

      const needsUpdate = Number.isFinite(currentLimit) && currentLimit > 0 && desiredLimit > currentLimit;
      if (needsUpdate) {
        const updateOptions: { public: boolean; fileSizeLimit?: string } = { public: isPublic };
        if (desiredLimit > 0) {
          updateOptions.fileSizeLimit = String(desiredLimit);
        }
        const { error: updateError } = await client.storage.updateBucket(bucket, updateOptions);
        if (updateError) {
          console.warn('Failed to update bucket limit, continuing without change:', updateError.message);
        }
      }
    }
    return;
  }

  if (error && !isNotFoundError(error)) {
    throw new Error(error.message || 'Supabase ストレージの取得に失敗しました。');
  }

  const createOptions: { public: boolean; fileSizeLimit?: string } = { public: isPublic };
  const limitIsFinite = Number.isFinite(sizeLimit) && sizeLimit > 0;
  if (limitIsFinite) {
    createOptions.fileSizeLimit = String(Math.floor(sizeLimit));
  }

  const { error: createError } = await client.storage.createBucket(bucket, createOptions);

  if (createError) {
    // Some projects reject large limits; retry without enforcing the limit so
    // uploads can proceed while the application enforces its own guardrails.
    const message = createError.message || 'Supabase ストレージバケットの作成に失敗しました。';
    if (limitIsFinite) {
      const { error: retryError } = await client.storage.createBucket(bucket, { public: isPublic });
      if (!retryError) {
        return;
      }
      throw new Error(retryError.message || message);
    }
    throw new Error(message);
  }
}
