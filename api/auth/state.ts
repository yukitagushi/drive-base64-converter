export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const anonKey = process.env.SUPABASE_ANON_KEY || '';
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const redirectTo = process.env.SUPABASE_GOOGLE_REDIRECT_URL || '';

    let googleUrl: string | null = null;

    if (supabaseUrl && anonKey) {
      const authorize = new URL(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/authorize`);
      authorize.searchParams.set('provider', 'google');
      if (redirectTo) {
        authorize.searchParams.set('redirect_to', redirectTo);
      }
      googleUrl = authorize.toString();
    }

    res.status(200).json({
      authenticated: false,
      user: null,
      staff: null,
      supabaseConfigured: Boolean(supabaseUrl && serviceRoleKey),
      authConfigured: Boolean(supabaseUrl && anonKey),
      supabase: supabaseUrl && anonKey ? { url: supabaseUrl, anonKey } : null,
      providers: {
        google: {
          enabled: Boolean(supabaseUrl && anonKey),
          url: googleUrl,
        },
      },
    });
  } catch (error: any) {
    console.error('Error in /api/auth/state:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}
