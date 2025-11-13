const { createClient } = require('@supabase/supabase-js');

let client = null;

function getSupabaseClient() {
  if (client) {
    return client;
  }

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase URL または ANON KEY が設定されていません。');
  }

  client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
    },
  });

  return client;
}

module.exports = { getSupabaseClient };
