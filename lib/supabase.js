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

class SupabaseService {
  constructor(options = {}) {
    this.url = options.url || process.env.SUPABASE_URL || '';
    this.serviceRoleKey = options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    this.defaultHeaders = this.serviceRoleKey
      ? {
          apikey: this.serviceRoleKey,
          Authorization: `Bearer ${this.serviceRoleKey}`,
        }
      : null;
  }

  isConfigured() {
    return Boolean(this.url && this.serviceRoleKey);
  }

  async getHierarchy() {
    if (!this.isConfigured()) {
      return clone(SAMPLE_HIERARCHY);
    }

    const [organizations, offices, staff] = await Promise.all([
      this.#select('organizations', 'id,name,created_at'),
      this.#select('offices', 'id,name,organization_id,created_at'),
      this.#select('staff_profiles', 'id,office_id,display_name,email,role,created_at')
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
}

module.exports = {
  SupabaseService,
};
