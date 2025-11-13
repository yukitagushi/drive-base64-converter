-- Sample seed data for Gemini lounge
-- Execute after creating Supabase auth users for the listed emails.

insert into organizations (id, name)
values
  ('11111111-2222-4333-8444-555555555555', 'デモ株式会社')
  on conflict (id) do update set name = excluded.name;

insert into offices (id, organization_id, name)
values
  ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '11111111-2222-4333-8444-555555555555', '本社 (東京)'),
  ('bbbbbbbb-cccc-dddd-eeee-ffffffffffff', '11111111-2222-4333-8444-555555555555', '京都支社')
  on conflict (id) do update set name = excluded.name;

-- Create staff profiles by linking existing auth users
insert into staff_profiles (id, user_id, office_id, email, display_name, role)
select
  'aaaa1111-bbbb-cccc-dddd-eeeeffff0001',
  id,
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  email,
  '山田 太郎',
  'manager'
from auth.users
where email = 'yamada@example.com'
on conflict (id) do update set office_id = excluded.office_id, display_name = excluded.display_name;

insert into staff_profiles (id, user_id, office_id, email, display_name, role)
select
  'aaaa1111-bbbb-cccc-dddd-eeeeffff0002',
  id,
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  email,
  '佐藤 花子',
  'member'
from auth.users
where email = 'sato@example.com'
on conflict (id) do update set office_id = excluded.office_id, display_name = excluded.display_name;

insert into staff_profiles (id, user_id, office_id, email, display_name, role)
select
  'aaaa1111-bbbb-cccc-dddd-eeeeffff0003',
  id,
  'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  email,
  '中村 次郎',
  'member'
from auth.users
where email = 'nakamura@example.com'
on conflict (id) do update set office_id = excluded.office_id, display_name = excluded.display_name;

-- Seed a demo file store entry
insert into file_stores (id, organization_id, office_id, gemini_store_name, display_name, created_by)
values (
  'feedface-feed-face-feed-000000000001',
  '11111111-2222-4333-8444-555555555555',
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'stores/demo-sample',
  'サンプル資料ストア',
  'aaaa1111-bbbb-cccc-dddd-eeeeffff0001'
)
on conflict (gemini_store_name) do update set display_name = excluded.display_name;

-- Seed an example chat thread
insert into chat_threads (id, office_id, staff_id, title)
values (
  'feedface-1234-5678-90ab-000000000000',
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'aaaa1111-bbbb-cccc-dddd-eeeeffff0001',
  '京都府の補助金情報について'
)
on conflict (id) do update set title = excluded.title;

insert into chat_messages (id, thread_id, author_staff_id, role, content)
values
  (
    'facefeed-1234-5678-90ab-000000000001',
    'feedface-1234-5678-90ab-000000000000',
    'aaaa1111-bbbb-cccc-dddd-eeeeffff0001',
    'user',
    '京都府の小規模事業者向け補助金の申請期限を教えてください。'
  ),
  (
    'facefeed-1234-5678-90ab-000000000002',
    'feedface-1234-5678-90ab-000000000000',
    null,
    'assistant',
    '最新の京都府公式資料によると、申請期限は 2024 年 4 月 30 日です。'
  )
on conflict (id) do nothing;
