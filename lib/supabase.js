const clone = typeof structuredClone === 'function'
  ? structuredClone
  : (value) => JSON.parse(JSON.stringify(value));

const SAMPLE_HIERARCHY = [
  {
    id: 'org-demo',
    name: 'デモ株式会社',
    offices: [
      {
        id: 'office-demo-hq',
        name: '本社 (東京)',
        organizationId: 'org-demo',
        staff: [
          {
            id: 'staff-demo-1',
            displayName: '山田 太郎',
            email: 'yamada@example.com',
            role: 'manager',
          },
          {
            id: 'staff-demo-2',
            displayName: '佐藤 花子',
            email: 'sato@example.com',
            role: 'member',
          },
          {
            id: 'staff-demo-4',
            displayName: 'デモスタッフ',
            email: '30.sc350@gmail.com',
            role: 'member',
          },
        ],
      },
      {
        id: 'office-demo-kyoto',
        name: '京都支社',
        organizationId: 'org-demo',
        staff: [
          {
            id: 'staff-demo-3',
            displayName: '中村 次郎',
            email: 'nakamura@example.com',
            role: 'member',
          },
        ],
      },
    ],
  },
];

const SAMPLE_THREADS = [
  {
    id: 'thread-demo-1',
    officeId: 'office-demo-hq',
    staffId: 'staff-demo-1',
    title: '京都府の補助金情報について',
    createdAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 3500 * 1000).toISOString(),
    lastMessage: {
      role: 'assistant',
      content: '京都府の中小企業向け補助金は2024年4月末まで申請可能です。',
      createdAt: new Date(Date.now() - 3500 * 1000).toISOString(),
    },
  },
  {
    id: 'thread-demo-2',
    officeId: 'office-demo-hq',
    staffId: 'staff-demo-2',
    title: '社内ナレッジの整理方針',
    createdAt: new Date(Date.now() - 7200 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 7100 * 1000).toISOString(),
    lastMessage: {
      role: 'assistant',
      content: 'Gemini File Search ストアに各部署のドキュメントを登録しましょう。',
      createdAt: new Date(Date.now() - 7100 * 1000).toISOString(),
    },
  },
];

const SAMPLE_AUTH_USERS = [
  {
    userId: 'user-demo-1',
    email: 'yamada@example.com',
    password: 'password123',
    displayName: '山田 太郎',
    staffId: 'staff-demo-1',
    officeId: 'office-demo-hq',
    organizationId: 'org-demo',
  },
  {
    userId: 'user-demo-2',
    email: 'sato@example.com',
    password: 'password123',
    displayName: '佐藤 花子',
    staffId: 'staff-demo-2',
    officeId: 'office-demo-hq',
    organizationId: 'org-demo',
  },
  {
    userId: 'user-demo-3',
    email: 'nakamura@example.com',
    password: 'password123',
    displayName: '中村 次郎',
    staffId: 'staff-demo-3',
    officeId: 'office-demo-kyoto',
    organizationId: 'org-demo',
  },
  {
    userId: 'user-demo-4',
    email: '30.sc350@gmail.com',
    password: '12341234',
    displayName: 'デモスタッフ',
    staffId: 'staff-demo-4',
    officeId: 'office-demo-hq',
    organizationId: 'org-demo',
  },
];

class SupabaseService {
  constructor(options = {}) {
    this.url = options.url || process.env.SUPABASE_URL || '';
    this.serviceRoleKey = options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    this.anonKey = options.anonKey || process.env.SUPABASE_ANON_KEY || '';
    this.googleRedirectUrl = options.googleRedirectUrl || process.env.SUPABASE_GOOGLE_REDIRECT_URL || '';
    this.authUrl = this.url ? `${this.url}/auth/v1` : '';
    this.defaultHeaders = this.serviceRoleKey
      ? {
          apikey: this.serviceRoleKey,
          Authorization: `Bearer ${this.serviceRoleKey}`,
        }
      : null;
    this.demoAuth = SAMPLE_AUTH_USERS;
  }

  isConfigured() {
    return Boolean(this.url && this.serviceRoleKey);
  }

  isAuthConfigured() {
    return Boolean(this.url && this.anonKey);
  }

  getBrowserConfig() {
    if (!this.isAuthConfigured()) {
      return null;
    }
    return {
      url: this.url,
      anonKey: this.anonKey,
    };
  }

  buildGoogleOAuthUrl({ redirectTo } = {}) {
    if (!this.isAuthConfigured()) {
      return null;
    }
    const target = redirectTo || this.googleRedirectUrl;
    if (!target) {
      return null;
    }
    const url = new URL(`${this.authUrl}/authorize`);
    url.searchParams.set('provider', 'google');
    url.searchParams.set('redirect_to', target);
    return url.toString();
  }

  async signInWithPassword({ email, password }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !password) {
      throw new Error('メールアドレスとパスワードを入力してください。');
    }

    if (!this.isAuthConfigured()) {
      const match = this.demoAuth.find((entry) => entry.email === normalizedEmail);
      if (!match || match.password !== password) {
        throw new Error('メールアドレスまたはパスワードが正しくありません。');
      }
      return {
        user: {
          id: match.userId,
          email: match.email,
          user_metadata: { full_name: match.displayName },
        },
        session: {
          access_token: `demo-access-${match.userId}`,
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: null,
        },
        staff: this.#getSampleStaffContext(match),
      };
    }

    const payload = await this.#authRequest('token?grant_type=password', {
      method: 'POST',
      body: { email: normalizedEmail, password },
    });
    const user = payload.user || null;
    const session = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_in: payload.expires_in,
      token_type: payload.token_type,
    };
    const staff = user ? await this.getStaffContext({ userId: user.id, email: normalizedEmail }) : null;
    return { user, session, staff };
  }

  async signUpWithPassword({ email, password, displayName, organizationName, officeName }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !password) {
      throw new Error('メールアドレスとパスワードを入力してください。');
    }
    const name = String(displayName || '').trim() || normalizedEmail;

    if (!this.isAuthConfigured()) {
      const existing = this.demoAuth.find((entry) => entry.email === normalizedEmail);
      if (existing) {
        throw new Error('既に登録されているメールアドレスです。');
      }
      const organizationLabel = String(organizationName || '新規組織').trim();
      const officeLabel = String(officeName || 'メインオフィス').trim();
      const staffContext = this.#ensureSampleHierarchy({
        displayName: name,
        email: normalizedEmail,
        organizationName: organizationLabel,
        officeName: officeLabel,
        password,
      });
      return {
        user: {
          id: staffContext.userId,
          email: normalizedEmail,
          user_metadata: { full_name: name },
        },
        session: {
          access_token: `demo-access-${staffContext.userId}`,
          refresh_token: null,
          expires_in: 3600,
          token_type: 'bearer',
        },
        staff: staffContext,
        confirmationRequired: false,
      };
    }

    const body = {
      email: normalizedEmail,
      password,
      data: {
        full_name: name,
        display_name: name,
      },
    };
    const response = await this.#authRequest('signup', { method: 'POST', body });
    const user = response.user || null;
    const session = response.session
      ? {
          access_token: response.session.access_token,
          refresh_token: response.session.refresh_token,
          expires_in: response.session.expires_in,
          token_type: response.session.token_type,
        }
      : null;

    if (!user) {
      throw new Error('ユーザーの作成に失敗しました。');
    }

    await this.ensureOrganizationHierarchyForNewStaff({
      userId: user.id,
      email: normalizedEmail,
      displayName: name,
      organizationName,
      officeName,
    });

    const staff = await this.getStaffContext({ userId: user.id, email: normalizedEmail });
    return {
      user,
      session,
      staff,
      confirmationRequired: !session,
    };
  }

  async signOut(accessToken) {
    if (!this.isAuthConfigured()) {
      return true;
    }
    if (!accessToken) {
      return true;
    }
    await this.#authRequest('logout', {
      method: 'POST',
      accessToken,
      body: {},
    });
    return true;
  }

  async getStaffContext({ userId, email }) {
    const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
    if (!this.isConfigured()) {
      const match = this.demoAuth.find((entry) => {
        if (userId && entry.userId === userId) return true;
        if (normalizedEmail && entry.email === normalizedEmail) return true;
        return false;
      });
      return this.#getSampleStaffContext(match);
    }

    const params = new URLSearchParams();
    params.set(
      'select',
      [
        'id',
        'email',
        'display_name',
        'role',
        'office_id',
        'office:offices(id,name,organization_id,organization:organizations(id,name))',
      ].join(',')
    );
    params.set('limit', '1');
    if (userId) {
      params.set('user_id', `eq.${userId}`);
    } else if (normalizedEmail) {
      params.set('email', `eq.${normalizedEmail}`);
    }

    const rows = await this.#get(`staff_profiles?${params.toString()}`);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      officeId: row.office?.id || row.office_id,
      officeName: row.office?.name || null,
      organizationId: row.office?.organization_id || null,
      organizationName: row.office?.organization?.name || null,
      userId: userId || null,
    };
  }

  async ensureOrganizationHierarchyForNewStaff({
    userId,
    email,
    displayName,
    organizationName,
    officeName,
  }) {
    if (!this.isConfigured()) {
      return this.#ensureSampleHierarchy({
        userId,
        email,
        displayName,
        organizationName,
        officeName,
      });
    }

    const trimmedOrg = String(organizationName || '').trim();
    const trimmedOffice = String(officeName || '').trim();

    let organization = null;
    if (trimmedOrg) {
      organization = await this.#findOrganizationByName(trimmedOrg);
      if (!organization) {
        const created = await this.#post('organizations', { name: trimmedOrg });
        organization = created[0];
      }
    }

    if (!organization) {
      const fallback = await this.#select('organizations', 'id,name');
      organization = fallback[0] || null;
      if (!organization) {
        const created = await this.#post('organizations', { name: '新規組織' });
        organization = created[0];
      }
    }

    let office = null;
    if (trimmedOffice) {
      office = await this.#findOfficeByName(organization.id, trimmedOffice);
    }
    if (!office) {
      const created = await this.#post('offices', {
        organization_id: organization.id,
        name: trimmedOffice || `${organization.name} オフィス`,
      });
      office = created[0];
    }

    const existing = await this.getStaffContext({ userId, email });
    if (existing?.id) {
      return existing;
    }

    const created = await this.#post('staff_profiles', {
      user_id: userId,
      office_id: office.id,
      email,
      display_name: displayName,
      role: 'member',
    });
    const staff = created[0];
    return {
      id: staff.id,
      email: staff.email,
      displayName: staff.display_name,
      role: staff.role,
      officeId: office.id,
      officeName: office.name,
      organizationId: organization.id,
      organizationName: organization.name,
      userId,
    };
  }

  async getHierarchy() {
    if (!this.isConfigured()) {
      return clone(SAMPLE_HIERARCHY);
    }

    const [organizations, offices, staff] = await Promise.all([
      this.#select('organizations', 'id,name,created_at'),
      this.#select('offices', 'id,name,organization_id,created_at'),
      this.#select('staff_profiles', 'id,office_id,display_name,email,role,created_at'),
    ]);

    const officeMap = new Map();
    offices.forEach((office) => {
      officeMap.set(office.id, {
        id: office.id,
        name: office.name,
        organizationId: office.organization_id,
        staff: [],
      });
    });

    staff.forEach((member) => {
      const office = officeMap.get(member.office_id);
      if (office) {
        office.staff.push({
          id: member.id,
          displayName: member.display_name,
          email: member.email,
          role: member.role,
        });
      }
    });

    return organizations.map((org) => ({
      id: org.id,
      name: org.name,
      offices: offices
        .filter((office) => office.organization_id === org.id)
        .map((office) => officeMap.get(office.id) || { id: office.id, name: office.name, staff: [] }),
    }));
  }

  async listThreads({ officeId, limit = 12 } = {}) {
    if (!this.isConfigured()) {
      return SAMPLE_THREADS.filter((thread) => !officeId || thread.officeId === officeId);
    }

    const params = new URLSearchParams();
    params.set('select', 'id,office_id,staff_id,title,created_at,updated_at,last_message');
    params.set('order', 'updated_at.desc');
    params.set('limit', String(limit));
    if (officeId) {
      params.set('office_id', `eq.${officeId}`);
    }

    const rows = await this.#get(`chat_thread_summaries?${params.toString()}`);
    return rows.map((row) => ({
      id: row.id,
      officeId: row.office_id,
      staffId: row.staff_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessage: row.last_message || null,
    }));
  }

  async ensureThread({ officeId, staffId, title }) {
    if (!this.isConfigured()) {
      const fallbackId = `thread-demo-${Date.now()}`;
      const thread = {
        id: fallbackId,
        officeId,
        staffId,
        title: title || '新しいスレッド',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: null,
      };
      SAMPLE_THREADS.unshift(thread);
      return thread;
    }

    const payload = { office_id: officeId, staff_id: staffId, title: title || '新しいスレッド' };
    const rows = await this.#post('chat_threads', payload);
    return rows[0] && {
      id: rows[0].id,
      officeId: rows[0].office_id,
      staffId: rows[0].staff_id,
      title: rows[0].title,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
      lastMessage: null,
    };
  }

  async recordMessages({ threadId, staffId, userMessage, assistantMessage, context }) {
    if (!this.isConfigured()) {
      return null;
    }

    const entries = [
      {
        thread_id: threadId,
        role: 'user',
        content: userMessage,
        author_staff_id: staffId,
        metadata: context ? { context } : null,
      },
      {
        thread_id: threadId,
        role: 'assistant',
        content: assistantMessage,
        author_staff_id: null,
        metadata: context ? { context } : null,
      },
    ];

    await this.#post('chat_messages', entries);
    await this.#patch(`chat_threads?id=eq.${threadId}`, { updated_at: new Date().toISOString() });
  }

  async recordAuthEvent({ staffId, type }) {
    if (!this.isConfigured()) {
      return;
    }
    await this.#post('staff_auth_events', {
      staff_id: staffId,
      event_type: type,
      occurred_at: new Date().toISOString(),
    });
  }

  async recordFileStore({ organizationId, officeId, staffId, geminiStoreName, displayName }) {
    if (!this.isConfigured()) {
      return null;
    }
    const rows = await this.#post('file_stores', {
      organization_id: organizationId || null,
      office_id: officeId,
      created_by: staffId,
      gemini_store_name: geminiStoreName,
      display_name: displayName,
    });
    return rows[0] || null;
  }

  async recordFileUpload({ fileStoreId, staffId, geminiFileName, displayName, description, sizeBytes, mimeType }) {
    if (!this.isConfigured()) {
      return null;
    }
    await this.#post('file_store_files', {
      file_store_id: fileStoreId,
      gemini_file_name: geminiFileName,
      display_name: displayName,
      description: description || null,
      uploaded_by: staffId,
      size_bytes: sizeBytes || null,
      mime_type: mimeType || null,
    });
  }

  async decorateStoresForOffice(stores, officeId) {
    if (!this.isConfigured() || !stores.length || !officeId) {
      return stores;
    }

    const names = stores.map((store) => store.name).filter(Boolean);
    if (!names.length) {
      return stores;
    }
    const filter = new URLSearchParams();
    filter.set('select', 'id,office_id,gemini_store_name,display_name,description');
    const quoted = names.map((n) => `"${String(n).replace(/"/g, '\\"')}"`).join(',');
    filter.set('gemini_store_name', `in.(${quoted})`);

    const records = await this.#get(`file_stores?${filter.toString()}`);
    const recordMap = new Map(records.map((row) => [row.gemini_store_name, row]));

    return stores
      .filter((store) => {
        const record = recordMap.get(store.name);
        return record ? record.office_id === officeId : false;
      })
      .map((store) => {
        const record = recordMap.get(store.name);
        if (!record) return store;
        return {
          ...store,
          displayName: record.display_name || store.displayName,
          supabaseMeta: record,
        };
      });
  }

  async findFileStoreRecord(name) {
    if (!this.isConfigured()) {
      return null;
    }
    const params = new URLSearchParams();
    params.set('select', 'id,gemini_store_name,office_id');
    params.set('gemini_store_name', `eq.${name}`);
    params.set('limit', '1');
    const rows = await this.#get(`file_stores?${params.toString()}`);
    return rows[0] || null;
  }

  async #select(table, columns) {
    const params = new URLSearchParams();
    params.set('select', columns);
    return this.#get(`${table}?${params.toString()}`);
  }

  async #get(path) {
    if (!this.isConfigured()) {
      throw new Error('Supabase is not configured');
    }
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method: 'GET',
      headers: {
        ...this.defaultHeaders,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase GET ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async #post(path, payload) {
    if (!this.isConfigured()) {
      return Array.isArray(payload) ? payload : [payload];
    }
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase POST ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async #patch(path, payload) {
    if (!this.isConfigured()) {
      return null;
    }
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: {
        ...this.defaultHeaders,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase PATCH ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async #findOrganizationByName(name) {
    if (!this.isConfigured()) {
      return null;
    }
    const params = new URLSearchParams();
    params.set('select', 'id,name');
    params.set('name', `eq.${name}`);
    params.set('limit', '1');
    const rows = await this.#get(`organizations?${params.toString()}`);
    return rows[0] || null;
  }

  async #findOfficeByName(organizationId, name) {
    if (!this.isConfigured()) {
      return null;
    }
    const params = new URLSearchParams();
    params.set('select', 'id,name,organization_id');
    params.set('organization_id', `eq.${organizationId}`);
    params.set('name', `eq.${name}`);
    params.set('limit', '1');
    const rows = await this.#get(`offices?${params.toString()}`);
    return rows[0] || null;
  }

  async #authRequest(path, { method = 'POST', body, accessToken, headers } = {}) {
    if (!this.isAuthConfigured()) {
      throw new Error('Supabase auth is not configured');
    }
    const finalHeaders = {
      apikey: this.anonKey,
      Authorization: `Bearer ${accessToken || this.anonKey}`,
      ...headers,
    };
    const hasBody = typeof body !== 'undefined';
    if (hasBody) {
      finalHeaders['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${this.authUrl}/${path}`, {
      method,
      headers: finalHeaders,
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = null;
      }
    }
    if (!res.ok) {
      const message =
        data?.error_description ||
        data?.msg ||
        data?.message ||
        text ||
        `Supabase auth ${method} ${path} failed`;
      throw new Error(message);
    }
    return data || {};
  }

  #ensureSampleHierarchy({ userId, email, displayName, organizationName, officeName, password }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const name = displayName || normalizedEmail;
    const orgName = organizationName || 'デモ株式会社';
    const officeLabel = officeName || 'メインオフィス';

    let organization = SAMPLE_HIERARCHY.find((org) => org.name === orgName);
    if (!organization) {
      organization = {
        id: `org-${Date.now().toString(36)}`,
        name: orgName,
        offices: [],
      };
      SAMPLE_HIERARCHY.push(organization);
    }

    let office = organization.offices.find((item) => item.name === officeLabel);
    if (!office) {
      office = {
        id: `office-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: officeLabel,
        organizationId: organization.id,
        staff: [],
      };
      organization.offices.push(office);
    }

    let staff = office.staff.find((member) => member.email === normalizedEmail);
    if (!staff) {
      staff = {
        id: `staff-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        displayName: name,
        email: normalizedEmail,
        role: 'member',
      };
      office.staff.push(staff);
    }

    let authEntry = this.demoAuth.find((entry) => entry.email === normalizedEmail);
    if (!authEntry) {
      authEntry = {
        userId: userId || `user-${staff.id}`,
        email: normalizedEmail,
        password: password || 'password123',
        displayName: name,
        staffId: staff.id,
        officeId: office.id,
        organizationId: organization.id,
      };
      this.demoAuth.push(authEntry);
    }

    return {
      id: staff.id,
      email: staff.email,
      displayName: staff.displayName,
      role: staff.role,
      officeId: office.id,
      officeName: office.name,
      organizationId: organization.id,
      organizationName: organization.name,
      userId: authEntry.userId,
    };
  }

  #getSampleStaffContext(match) {
    if (!match) {
      return null;
    }
    const organization = SAMPLE_HIERARCHY.find((org) => org.id === match.organizationId);
    const office = organization?.offices?.find((item) => item.id === match.officeId);
    const staff = office?.staff?.find((member) => member.id === match.staffId);
    if (!organization || !office || !staff) {
      return null;
    }
    return {
      id: staff.id,
      email: staff.email,
      displayName: staff.displayName,
      role: staff.role,
      officeId: office.id,
      officeName: office.name,
      organizationId: organization.id,
      organizationName: organization.name,
      userId: match.userId,
    };
  }
}

module.exports = {
  SupabaseService,
};
