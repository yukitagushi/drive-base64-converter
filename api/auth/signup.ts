import { getSupabaseAdmin } from '../../lib/supabaseAdmin';

type Request = any;
type Response = any;

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch (error: any) {
    console.error('Supabase admin init error:', error);
    res.status(500).json({ error: 'Supabase 管理クライアントの初期化に失敗しました。' });
    return;
  }

  let payload: any = {};
  try {
    if (typeof req.body === 'string') {
      payload = req.body ? JSON.parse(req.body) : {};
    } else if (req.body && typeof req.body === 'object') {
      payload = req.body;
    }
  } catch (error: any) {
    res.status(400).json({ error: 'JSON 形式で送信してください。' });
    return;
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';
  const displayName = typeof payload.name === 'string' ? payload.name.trim() : '';
  const orgName = typeof payload.orgName === 'string' ? payload.orgName.trim() : '';
  const officeName = typeof payload.officeName === 'string' ? payload.officeName.trim() : '';

  if (!email || !password || !displayName) {
    res.status(400).json({ error: '氏名・メールアドレス・パスワードは必須です。' });
    return;
  }

  try {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: displayName,
        display_name: displayName,
      },
    });

    if (error) {
      res.status(400).json({ error: error.message || 'ユーザーの作成に失敗しました。' });
      return;
    }

    const user = data?.user;
    if (!user) {
      res.status(500).json({ error: 'ユーザー情報を取得できませんでした。' });
      return;
    }

    const organization = await ensureOrganization(admin, orgName || displayName || email);
    const office = await ensureOffice(admin, organization.id, officeName || `${displayName} オフィス`);
    const staff = await ensureStaffProfile(admin, {
      userId: user.id,
      email,
      displayName,
      officeId: office.id,
    });

    res.status(201).json({ ok: true, userId: user.id, officeId: staff.officeId, staffId: staff.id });
  } catch (error: any) {
    console.error('Error in /api/auth/signup:', error);
    res.status(500).json({ error: error?.message || 'サインアップ処理に失敗しました。' });
  }
}

async function ensureOrganization(admin: any, name: string): Promise<{ id: string }> {
  const label = name ? name.trim() : '';
  if (label) {
    const { data, error } = await admin
      .from('organizations')
      .select('id')
      .eq('name', label)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') {
      throw new Error(error.message);
    }
    if (data) {
      return data;
    }
    const { data: created, error: insertError } = await admin
      .from('organizations')
      .insert({ name: label })
      .select('id')
      .single();
    if (insertError) {
      throw new Error(insertError.message);
    }
    return created;
  }

  const { data, error } = await admin.from('organizations').select('id').order('created_at', { ascending: true }).limit(1);
  if (error) {
    throw new Error(error.message);
  }
  if (data && data.length > 0) {
    return data[0];
  }
  const { data: created, error: insertError } = await admin
    .from('organizations')
    .insert({ name: '新規組織' })
    .select('id')
    .single();
  if (insertError) {
    throw new Error(insertError.message);
  }
  return created;
}

async function ensureOffice(admin: any, organizationId: string, name: string): Promise<{ id: string }> {
  const label = name ? name.trim() : '';
  if (label) {
    const { data, error } = await admin
      .from('offices')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('name', label)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') {
      throw new Error(error.message);
    }
    if (data) {
      return data;
    }
  }

  const fallbackName = label || 'メインオフィス';
  const { data, error } = await admin
    .from('offices')
    .insert({ organization_id: organizationId, name: fallbackName })
    .select('id')
    .single();
  if (error) {
    throw new Error(error.message);
  }
  return data;
}

async function ensureStaffProfile(
  admin: any,
  params: { userId: string; email: string; displayName: string; officeId: string }
): Promise<{ id: string; officeId: string }> {
  const { userId, email, displayName, officeId } = params;
  const { data: existing, error: existingError } = await admin
    .from('staff_profiles')
    .select('id, office_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (existingError && existingError.code !== 'PGRST116') {
    throw new Error(existingError.message);
  }
  if (existing) {
    return { id: existing.id, officeId: existing.office_id };
  }

  const { data, error } = await admin
    .from('staff_profiles')
    .insert({
      user_id: userId,
      office_id: officeId,
      email,
      display_name: displayName || email,
      role: 'member',
    })
    .select('id, office_id')
    .single();
  if (error) {
    throw new Error(error.message);
  }
  return { id: data.id, officeId: data.office_id };
}
