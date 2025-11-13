const { getSupabaseService } = require('../../lib/serverContext');
const {
  getAuthState,
  clearAuthContext,
  buildAuthPayload,
  buildSessionPayload,
  resetSessionAfterLogout,
} = require('../../lib/serverState');

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const supabase = getSupabaseService();
  const auth = getAuthState();

  try {
    if (auth?.tokens?.accessToken) {
      await supabase.signOut(auth.tokens.accessToken).catch((error: any) => {
        console.error('Supabase sign-out failed:', error?.message || error);
      });
    }

    if (supabase.isConfigured() && auth?.staff?.id) {
      await supabase
        .recordAuthEvent({ staffId: auth.staff.id, type: 'logout' })
        .catch((error: any) => console.error('Supabase auth event error:', error?.message || error));
    }
  } catch (error: any) {
    console.error('Logout handling error:', error?.message || error);
  }

  clearAuthContext();
  await resetSessionAfterLogout();

  const [authPayload, sessionPayload] = await Promise.all([
    buildAuthPayload(),
    buildSessionPayload(),
  ]);

  res.status(200).json({ auth: authPayload, session: sessionPayload });
}
