import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase URL または ANON KEY が設定されていません。');
  }

  return { url, anonKey };
}

export function getSupabaseClient(): SupabaseClient {
  if (client) {
    return client;
  }

  const { url, anonKey } = getSupabaseEnv();

  client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
    },
  });

  return client;
}

export function getSupabaseClientWithToken(accessToken: string): SupabaseClient {
  if (!accessToken) {
    throw new Error('Supabase アクセストークンが指定されていません。');
  }

  const { url, anonKey } = getSupabaseEnv();

  return createClient(url, anonKey, {
    global: {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      persistSession: false,
    },
  });
}
