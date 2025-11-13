const { createClient } = require('@supabase/supabase-js');

let adminClient = null;

function getSupabaseAdmin() {
  if (adminClient) {
    return adminClient;
  }

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error('Supabase URL または SERVICE ROLE KEY が設定されていません。');
  }

  adminClient = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });

  return adminClient;
}

module.exports = { getSupabaseAdmin };
