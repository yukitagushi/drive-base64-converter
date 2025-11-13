const { getSupabaseService, ensureKnowledge } = require('./serverContext');

const authState = {
  user: null,
  staff: null,
  tokens: null,
};

const sessionState = {
  organizationId: null,
  officeId: null,
  staffId: null,
  threadId: null,
};

let sessionInitialized = false;

const SESSION_COOKIE_NAME = 'lounge_session';
const DEFAULT_SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function parseCookieHeader(header) {
  if (!header || typeof header !== 'string') {
    return {};
  }
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) {
        return acc;
      }
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name) {
        acc[name] = value;
      }
      return acc;
    }, {});
}

function encodeSessionValue(value) {
  const json = JSON.stringify(value || {});
  const base64 = Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return base64;
}

function decodeSessionValue(value) {
  if (!value) {
    return null;
  }
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch (error) {
    console.error('Failed to decode session cookie:', error?.message || error);
    return null;
  }
}

function readSessionCookie(req) {
  try {
    const header = req?.headers?.cookie || '';
    const cookies = parseCookieHeader(header);
    const raw = cookies[SESSION_COOKIE_NAME];
    return decodeSessionValue(raw);
  } catch (error) {
    console.error('Failed to read session cookie:', error?.message || error);
    return null;
  }
}

function appendSetCookie(res, value) {
  if (!res || !value) {
    return;
  }
  const existing = res.getHeader ? res.getHeader('Set-Cookie') : undefined;
  const entries = Array.isArray(existing) ? existing.slice() : existing ? [existing] : [];
  entries.push(value);
  if (typeof res.setHeader === 'function') {
    res.setHeader('Set-Cookie', entries);
  }
}

function issueSessionCookie(res, { user, staff, tokens }) {
  if (!res || !user || !staff) {
    return;
  }
  const payload = {
    user,
    staff,
    tokens: tokens || null,
  };
  const encoded = encodeSessionValue(payload);
  const maxAge = tokens?.expiresIn ? Math.max(60, Number(tokens.expiresIn)) : DEFAULT_SESSION_MAX_AGE;
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encoded}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
  appendSetCookie(res, cookie);
}

function clearSessionCookie(res) {
  if (!res) {
    return;
  }
  const cookie = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'].join('; ');
  appendSetCookie(res, cookie);
}

function getAuthState() {
  return authState;
}

function getSessionState() {
  return sessionState;
}

function setAuthContext({ user, staff, tokens }) {
  authState.user = user || null;
  authState.staff = staff || null;
  authState.tokens = tokens || null;
  syncSessionWithAuth();
}

function clearAuthContext() {
  authState.user = null;
  authState.staff = null;
  authState.tokens = null;
}

function syncSessionWithAuth() {
  if (authState.staff) {
    sessionState.organizationId = authState.staff.organizationId || null;
    sessionState.officeId = authState.staff.officeId || null;
    sessionState.staffId = authState.staff.id || null;
  }
}

async function ensureSessionInitialized() {
  if (sessionInitialized) {
    return;
  }
  await initializeSession();
  sessionInitialized = true;
}

async function initializeSession() {
  const supabase = getSupabaseService();
  try {
    const hierarchy = await supabase.getHierarchy();
    if (supabase.isConfigured() && authState.staff) {
      return;
    }
    const firstOrg = hierarchy[0];
    if (firstOrg && !sessionState.organizationId) {
      sessionState.organizationId = firstOrg.id;
    }
    const firstOffice = firstOrg?.offices?.[0];
    if (firstOffice && !sessionState.officeId) {
      sessionState.officeId = firstOffice.id;
    }
    const firstStaff = firstOffice?.staff?.[0];
    if (firstStaff && !sessionState.staffId) {
      sessionState.staffId = firstStaff.id;
    }
  } catch (error) {
    console.error('Supabase session init failed:', error?.message || error);
  }
}

async function ensureDemoAuthContext() {
  const supabase = getSupabaseService();
  if (supabase.isAuthConfigured()) {
    return;
  }
  if (authState.user && authState.staff) {
    return;
  }
  try {
    const hierarchy = await supabase.getHierarchy();
    const organization = hierarchy?.[0];
    const office = organization?.offices?.[0];
    const staff = office?.staff?.[0];
    if (!organization || !office || !staff) {
      return;
    }
    const email = staff.email || `${staff.id}@example.com`;
    const displayName = staff.displayName || email;
    setAuthContext({
      user: {
        id: staff.userId || `user-${staff.id}`,
        email,
        displayName,
      },
      staff: {
        id: staff.id,
        email,
        displayName,
        officeId: office.id || null,
        officeName: office.name || null,
        organizationId: office.organizationId || organization.id || null,
        organizationName: organization.name || null,
        role: staff.role || 'member',
      },
      tokens: null,
    });
  } catch (error) {
    console.error('Failed to ensure demo auth context:', error?.message || error);
  }
}

async function hydrateAuthFromRequest(req) {
  const supabase = getSupabaseService();
  const payload = readSessionCookie(req);
  if (payload?.user && payload?.staff) {
    setAuthContext({
      user: payload.user,
      staff: payload.staff,
      tokens: payload.tokens || null,
    });
    return true;
  }

  clearAuthContext();

  if (supabase.isConfigured()) {
    await resetSessionAfterLogout();
    return false;
  }

  await ensureDemoAuthContext();
  return Boolean(authState.user && authState.staff);
}

function updateSessionState(partial) {
  const supabase = getSupabaseService();

  if (!partial || typeof partial !== 'object') {
    return { ...sessionState };
  }

  if (supabase.isConfigured()) {
    if (!authState.staff) {
      return { ...sessionState };
    }
    sessionState.organizationId = authState.staff.organizationId || null;
    sessionState.officeId = authState.staff.officeId || null;
    sessionState.staffId = authState.staff.id || null;
    if ('threadId' in partial) {
      sessionState.threadId = partial.threadId || null;
    }
    return { ...sessionState };
  }

  if ('organizationId' in partial) {
    const previousOrganization = sessionState.organizationId;
    sessionState.organizationId = partial.organizationId || null;
    if (previousOrganization && previousOrganization !== sessionState.organizationId) {
      sessionState.officeId = null;
      sessionState.staffId = null;
      sessionState.threadId = null;
    }
  }

  if ('officeId' in partial) {
    const previousOffice = sessionState.officeId;
    sessionState.officeId = partial.officeId || null;
    if (previousOffice && previousOffice !== sessionState.officeId) {
      sessionState.staffId = null;
      sessionState.threadId = null;
    }
  }

  if ('staffId' in partial) {
    const previousStaff = sessionState.staffId;
    sessionState.staffId = partial.staffId || null;
    if (previousStaff && previousStaff !== sessionState.staffId) {
      sessionState.threadId = null;
    }
  }

  if ('threadId' in partial) {
    sessionState.threadId = partial.threadId || null;
  }

  return { ...sessionState };
}

async function buildSessionPayload() {
  const supabase = getSupabaseService();
  await ensureSessionInitialized();

  let hierarchy = [];
  try {
    hierarchy = await supabase.getHierarchy();
  } catch (error) {
    console.error('Supabase hierarchy error:', error?.message || error);
  }

  if (!supabase.isConfigured() && !hierarchy.length) {
    await ensureDemoKnowledge();
  }

  let filteredHierarchy = hierarchy;

  if (supabase.isConfigured()) {
    if (authState.staff) {
      filteredHierarchy = hierarchy
        .filter((org) => org.id === authState.staff.organizationId)
        .map((org) => ({
          ...org,
          offices: (org.offices || []).filter((office) => office.id === authState.staff.officeId),
        }));
      sessionState.organizationId = authState.staff.organizationId || null;
      sessionState.officeId = authState.staff.officeId || null;
      sessionState.staffId = authState.staff.id || null;
    } else {
      filteredHierarchy = [];
      sessionState.organizationId = null;
      sessionState.officeId = null;
      sessionState.staffId = null;
      sessionState.threadId = null;
    }
  } else {
    if (!sessionState.organizationId && filteredHierarchy[0]) {
      sessionState.organizationId = filteredHierarchy[0].id;
    }

    if (!sessionState.officeId) {
      const org =
        filteredHierarchy.find((item) => item.id === sessionState.organizationId) || filteredHierarchy[0];
      if (org?.offices?.length) {
        sessionState.officeId = org.offices[0].id;
      }
    }

    if (!sessionState.staffId) {
      const office = filteredHierarchy
        .flatMap((org) => org.offices || [])
        .find((item) => item.id === sessionState.officeId);
      if (office?.staff?.length) {
        sessionState.staffId = office.staff[0].id;
      }
    }
  }

  const currentOffice = filteredHierarchy
    .flatMap((org) => org.offices || [])
    .find((item) => item.id === sessionState.officeId);
  if (currentOffice?.organizationId && sessionState.organizationId !== currentOffice.organizationId) {
    sessionState.organizationId = currentOffice.organizationId;
  }

  let threads = [];
  if (sessionState.officeId && (!supabase.isConfigured() || authState.staff)) {
    try {
      threads = await supabase.listThreads({ officeId: sessionState.officeId });
    } catch (error) {
      console.error('Supabase thread list error:', error?.message || error);
      threads = [];
    }
  }

  return {
    supabaseConfigured: supabase.isConfigured(),
    hierarchy: filteredHierarchy,
    session: { ...sessionState },
    threads,
  };
}

async function buildAuthPayload() {
  const supabase = getSupabaseService();
  const supabaseConfig = supabase.getBrowserConfig();
  const googleUrl = supabase.buildGoogleOAuthUrl({ redirectTo: process.env.SUPABASE_GOOGLE_REDIRECT_URL });
  const googleEnabled = Boolean(googleUrl && supabaseConfig);
  await ensureDemoAuthContext();
  return {
    authenticated: Boolean(authState.user && authState.staff),
    user: authState.user
      ? {
          id: authState.user.id,
          email: authState.user.email,
          displayName: authState.user.displayName,
        }
      : null,
    staff: authState.staff
      ? {
          id: authState.staff.id,
          email: authState.staff.email,
          displayName: authState.staff.displayName,
          officeId: authState.staff.officeId,
          officeName: authState.staff.officeName,
          organizationId: authState.staff.organizationId,
          organizationName: authState.staff.organizationName,
          role: authState.staff.role,
        }
      : null,
    supabaseConfigured: supabase.isConfigured(),
    authConfigured: supabase.isAuthConfigured(),
    supabase: supabaseConfig,
    providers: {
      google: {
        enabled: googleEnabled,
        url: googleEnabled ? googleUrl : null,
      },
    },
  };
}

async function resetSessionAfterLogout() {
  sessionState.organizationId = null;
  sessionState.officeId = null;
  sessionState.staffId = null;
  sessionState.threadId = null;
  sessionInitialized = false;
  const supabase = getSupabaseService();
  if (!supabase.isConfigured()) {
    await ensureSessionInitialized();
  }
}

async function ensureDemoKnowledge() {
  try {
    await ensureKnowledge();
  } catch (error) {
    console.error('Knowledge ensure failed:', error?.message || error);
  }
}

module.exports = {
  getAuthState,
  getSessionState,
  setAuthContext,
  clearAuthContext,
  syncSessionWithAuth,
  hydrateAuthFromRequest,
  issueSessionCookie,
  clearSessionCookie,
  updateSessionState,
  buildAuthPayload,
  buildSessionPayload,
  resetSessionAfterLogout,
  ensureSessionInitialized,
  ensureDemoKnowledge,
  ensureDemoAuthContext,
};
