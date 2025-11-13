-- Supabase schema for Gemini knowledge lounge
-- Run with: supabase db push --file supabase/schema.sql

create extension if not exists "pgcrypto";

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists offices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists staff_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  office_id uuid not null references offices(id) on delete cascade,
  email text not null unique,
  display_name text not null,
  role text not null default 'member',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists staff_auth_events (
  id bigserial primary key,
  staff_id uuid not null references staff_profiles(id) on delete cascade,
  event_type text not null check (event_type in ('login', 'logout')),
  occurred_at timestamptz not null default timezone('utc', now()),
  metadata jsonb
);

create table if not exists file_stores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  office_id uuid not null references offices(id) on delete cascade,
  gemini_store_name text not null unique,
  display_name text not null,
  description text,
  created_by uuid references staff_profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists file_store_files (
  id uuid primary key default gen_random_uuid(),
  file_store_id uuid not null references file_stores(id) on delete cascade,
  gemini_file_name text not null,
  display_name text not null,
  description text,
  size_bytes bigint,
  mime_type text,
  uploaded_by uuid references staff_profiles(id),
  uploaded_at timestamptz not null default timezone('utc', now())
);

create table if not exists chat_threads (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references offices(id) on delete cascade,
  staff_id uuid references staff_profiles(id),
  title text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references chat_threads(id) on delete cascade,
  author_staff_id uuid references staff_profiles(id),
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  metadata jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_staff_profiles_office on staff_profiles(office_id);
create index if not exists idx_file_stores_office on file_stores(office_id);
create index if not exists idx_file_store_files_store on file_store_files(file_store_id);
create index if not exists idx_chat_threads_office on chat_threads(office_id);
create index if not exists idx_chat_messages_thread_created on chat_messages(thread_id, created_at desc);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

create trigger staff_profiles_set_updated_at
  before update on staff_profiles
  for each row execute function set_updated_at();

create trigger chat_threads_set_updated_at
  before update on chat_threads
  for each row execute function set_updated_at();

create or replace view chat_thread_summaries as
select
  t.id,
  t.office_id,
  t.staff_id,
  t.title,
  t.created_at,
  t.updated_at,
  (
    select jsonb_build_object(
      'id', m.id,
      'role', m.role,
      'content', m.content,
      'createdAt', m.created_at
    )
    from chat_messages m
    where m.thread_id = t.id
    order by m.created_at desc
    limit 1
  ) as last_message
from chat_threads t;
