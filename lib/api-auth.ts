import type { VercelRequest } from '@vercel/node';

interface StaffContext {
  id: string;
  email: string;
  displayName: string;
  role: string;
  officeId: string | null;
  officeName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  userId?: string | null;
}

interface SessionState {
  organizationId: string | null;
  officeId: string | null;
  staffId: string | null;
  threadId: string | null;
  supabaseConfigured: boolean;
}

export interface SessionPayload {
  supabaseConfigured: boolean;
  hierarchy: any[];
  session: SessionState;
  threads: any[];
}

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const redirectUrl = process.env.SUPABASE_GOOGLE_REDIRECT_URL || '';
  return { url, anonKey, serviceRoleKey, redirectUrl };
}

export function isSupabaseConfigured(): boolean {
  const { url, serviceRoleKey } = getSupabaseEnv();
  return Boolean(url && serviceRoleKey);
}

export function isSupabaseAuthConfigured(): boolean {
  const { url, anonKey } = getSupabaseEnv();
  return Boolean(url && anonKey);
}

export function buildProviders() {
  const { url, anonKey, redirectUrl } = getSupabaseEnv();
  let googleUrl: string | null = null;
  if (url && anonKey) {
    try {
      const authorize = new URL(`${url.replace(/\/$/, '')}/auth/v1/authorize`);
      authorize.searchParams.set('provider', 'google');
      if (redirectUrl) {
        authorize.searchParams.set('redirect_to', redirectUrl);
      }
      googleUrl = authorize.toString();
    } catch (error) {
      console.error('Failed to build Google authorize URL:', error);
      googleUrl = null;
    }
  }
  return {
    google: {
      enabled: Boolean(googleUrl),
      url: googleUrl,
    },
  };
}

export function buildAuthPayload(params: { user?: any | null; staff?: StaffContext | null }) {
  const { url, anonKey, serviceRoleKey } = getSupabaseEnv();
  const supabaseConfigured = Boolean(url && serviceRoleKey);
  const authConfigured = Boolean(url && anonKey);
  const user = params.user || null;
  const staff = params.staff || null;

  const displayNameFromUser =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.display_name ||
    user?.user_metadata?.name ||
    user?.email ||
    null;

  return {
    authenticated: Boolean(user && staff),
    user: user
      ? {
          id: user.id,
          email: user.email,
          displayName: staff?.displayName || displayNameFromUser || user.email,
        }
      : null,
    staff: staff
      ? {
          id: staff.id,
          email: staff.email,
          displayName: staff.displayName,
          officeId: staff.officeId,
          officeName: staff.officeName,
          organizationId: staff.organizationId,
          organizationName: staff.organizationName,
          role: staff.role,
        }
      : null,
    supabaseConfigured,
    authConfigured,
    supabase: authConfigured && url && anonKey ? { url, anonKey } : null,
    providers: buildProviders(),
  };
}

export function buildGuestSessionPayload(): SessionPayload {
  const supabaseConfigured = isSupabaseConfigured();
  return {
    supabaseConfigured,
    hierarchy: [],
    session: {
      organizationId: null,
      officeId: null,
      staffId: null,
      threadId: null,
      supabaseConfigured,
    },
    threads: [],
  };
}

export function getSupabaseBearerToken(req: VercelRequest): string | null {
  const header = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
  if (header && typeof header === 'string') {
    const trimmed = header.trim();
    if (/^Bearer\s+/i.test(trimmed)) {
      const token = trimmed.replace(/^Bearer\s+/i, '').trim();
      return token || null;
    }
  }

  if (req.method && req.method !== 'GET') {
    const body: any = typeof req.body === 'string' ? safeJson(req.body) : req.body;
    if (body && typeof body === 'object' && typeof body.accessToken === 'string') {
      return body.accessToken.trim() || null;
    }
  }

  const query = req.query as Record<string, string | string[] | undefined>;
  const queryToken = query.accessToken;
  if (typeof queryToken === 'string') {
    return queryToken.trim() || null;
  }
  if (Array.isArray(queryToken) && queryToken.length > 0) {
    return (queryToken[0] || '').trim() || null;
  }

  return null;
}

function safeJson(raw: string) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

export async function resolveUserFromToken(admin: any, accessToken: string) {
  const { data, error } = await admin.auth.getUser(accessToken);
  if (error) {
    throw new Error(error.message || 'ユーザー情報の取得に失敗しました。');
  }
  if (!data?.user) {
    throw new Error('ユーザー情報が見つかりません。');
  }
  return data.user;
}

export async function resolveStaffContext(admin: any, options: { userId?: string | null; email?: string | null }): Promise<StaffContext | null> {
  const query = admin
    .from('staff_profiles')
    .select(
      [
        'id',
        'email',
        'display_name',
        'role',
        'office_id',
        'user_id',
        'office:offices(id,name,organization_id,organization:organizations(id,name))',
      ].join(',')
    )
    .limit(1);

  if (options.userId) {
    query.eq('user_id', options.userId);
  } else if (options.email) {
    query.eq('email', options.email.toLowerCase());
  }

  const { data, error } = await query.maybeSingle();
  if (error && error.code !== 'PGRST116') {
    throw new Error(error.message);
  }
  if (!data) {
    return null;
  }

  const office = data.office || null;
  const organization = office?.organization || null;

  return {
    id: data.id,
    email: data.email,
    displayName: data.display_name,
    role: data.role,
    officeId: office?.id || data.office_id || null,
    officeName: office?.name || null,
    organizationId: organization?.id || office?.organization_id || null,
    organizationName: organization?.name || null,
    userId: data.user_id || null,
  };
}

async function loadHierarchy(admin: any) {
  const { data, error } = await admin
    .from('organizations')
    .select('id,name,created_at,offices:offices(id,name,organization_id,created_at,staff:staff_profiles(id,display_name,email,role))')
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((org: any) => ({
    id: org.id,
    name: org.name,
    offices: (org.offices || []).map((office: any) => ({
      id: office.id,
      name: office.name,
      organizationId: office.organization_id || org.id,
      staff: (office.staff || []).map((member: any) => ({
        id: member.id,
        displayName: member.display_name,
        email: member.email,
        role: member.role,
      })),
    })),
  }));
}

async function fetchThreads(admin: any, officeId: string | null) {
  if (!officeId) {
    return [];
  }
  const { data, error } = await admin
    .from('chat_thread_summaries')
    .select('id,office_id,staff_id,title,created_at,updated_at,last_message')
    .eq('office_id', officeId)
    .order('updated_at', { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    officeId: row.office_id,
    staffId: row.staff_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessage: row.last_message || null,
  }));
}

export async function buildSessionPayload(admin: any, staff: StaffContext | null): Promise<SessionPayload> {
  const supabaseConfigured = isSupabaseConfigured();
  if (!supabaseConfigured || !admin) {
    return buildGuestSessionPayload();
  }

  let hierarchy: any[] = [];
  try {
    hierarchy = await loadHierarchy(admin);
  } catch (error: any) {
    console.error('Hierarchy load error:', error?.message || error);
    hierarchy = [];
  }

  let filteredHierarchy = hierarchy;
  if (staff) {
    filteredHierarchy = hierarchy
      .filter((org) => !staff.organizationId || org.id === staff.organizationId)
      .map((org) => ({
        ...org,
        offices: (org.offices || []).filter((office: any) => !staff.officeId || office.id === staff.officeId),
      }));
  }

  const firstOrg = filteredHierarchy[0];
  const firstOffice = firstOrg?.offices?.[0];

  const session: SessionState = {
    organizationId: staff?.organizationId || firstOrg?.id || null,
    officeId: staff?.officeId || firstOffice?.id || null,
    staffId: staff?.id || null,
    threadId: null,
    supabaseConfigured,
  };

  let threads: any[] = [];
  try {
    threads = await fetchThreads(admin, session.officeId);
  } catch (error: any) {
    console.error('Thread load error:', error?.message || error);
    threads = [];
  }

  return {
    supabaseConfigured,
    hierarchy: filteredHierarchy,
    session,
    threads,
  };
}

export async function resolveStaffForRequest(admin: any, req: VercelRequest): Promise<StaffContext | null> {
  const token = getSupabaseBearerToken(req);
  if (!token) {
    return null;
  }
  try {
    const user = await resolveUserFromToken(admin, token);
    return await resolveStaffContext(admin, { userId: user.id, email: user.email });
  } catch (error) {
    console.error('resolveStaffForRequest error:', error);
    return null;
  }
}
