const { getSupabaseService, ensureKnowledge } = require('../lib/serverContext');

export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'GET') {
      await handleGet(res);
      return;
    }

    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error: any) {
    console.error('Error in /api/session:', error);
    res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
}

async function handleGet(res: any) {
  const supabase = getSupabaseService();
  let hierarchy: any[] = [];

  if (!supabase.isConfigured()) {
    try {
      hierarchy = await supabase.getHierarchy();
    } catch (error: any) {
      console.error('Supabase hierarchy error:', error?.message || error);
      hierarchy = [];
    }
  }

  const session = {
    organizationId: null,
    officeId: null,
    staffId: null,
    threadId: null,
    supabaseConfigured: supabase.isConfigured(),
  };

  if (!supabase.isConfigured()) {
    if (!hierarchy.length) {
      const knowledge = await ensureKnowledge();
      if (knowledge?.listDocuments) {
        // no-op but ensures init for state endpoint consistency
      }
    }
    if (hierarchy[0]) {
      session.organizationId = hierarchy[0].id;
      const firstOffice = hierarchy[0].offices?.[0];
      if (firstOffice) {
        session.officeId = firstOffice.id;
        const firstStaff = firstOffice.staff?.[0];
        if (firstStaff) {
          session.staffId = firstStaff.id;
        }
      }
    }
  }

  let threads = [];
  if (session.officeId) {
    try {
      threads = await supabase.listThreads({ officeId: session.officeId });
    } catch (error: any) {
      console.error('Supabase thread list error:', error?.message || error);
      threads = [];
    }
  }

  res.status(200).json({
    supabaseConfigured: supabase.isConfigured(),
    hierarchy: supabase.isConfigured() ? [] : hierarchy,
    session,
    threads,
  });
}
