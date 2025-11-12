-- Row level security policies for Gemini lounge

alter table organizations enable row level security;
alter table offices enable row level security;
alter table staff_profiles enable row level security;
alter table staff_auth_events enable row level security;
alter table file_stores enable row level security;
alter table file_store_files enable row level security;
alter table chat_threads enable row level security;
alter table chat_messages enable row level security;

-- Helper predicate: current user belongs to office/organization
create policy "staff view organizations" on organizations
  for select using (
    exists (
      select 1
      from staff_profiles sp
      join offices o on o.id = sp.office_id
      where sp.user_id = auth.uid()
        and o.organization_id = organizations.id
    )
  );

create policy "staff view offices" on offices
  for select using (
    exists (
      select 1
      from staff_profiles sp
      where sp.user_id = auth.uid()
        and sp.office_id = offices.id
    )
  );

create policy "staff view peers" on staff_profiles
  for select using (
    exists (
      select 1
      from staff_profiles self
      where self.user_id = auth.uid()
        and self.office_id = staff_profiles.office_id
    )
  );

create policy "staff update self" on staff_profiles
  for update using (auth.uid() = staff_profiles.user_id)
  with check (auth.uid() = staff_profiles.user_id);

create policy "staff view auth events" on staff_auth_events
  for select using (
    exists (
      select 1
      from staff_profiles self
      where self.user_id = auth.uid()
        and self.id = staff_auth_events.staff_id
    )
  );

create policy "staff view file stores" on file_stores
  for select using (
    exists (
      select 1
      from staff_profiles sp
      where sp.user_id = auth.uid()
        and sp.office_id = file_stores.office_id
    )
  );

create policy "staff insert file stores" on file_stores
  for insert with check (
    auth.role() = 'service_role'
    or exists (
      select 1
      from staff_profiles sp
      where sp.user_id = auth.uid()
        and sp.office_id = file_stores.office_id
    )
  );

create policy "staff view file store files" on file_store_files
  for select using (
    exists (
      select 1
      from file_stores fs
      join staff_profiles sp on sp.office_id = fs.office_id
      where sp.user_id = auth.uid()
        and fs.id = file_store_files.file_store_id
    )
  );

create policy "staff insert file store files" on file_store_files
  for insert with check (
    auth.role() = 'service_role'
    or exists (
      select 1
      from file_stores fs
      join staff_profiles sp on sp.office_id = fs.office_id
      where sp.user_id = auth.uid()
        and fs.id = file_store_files.file_store_id
    )
  );

create policy "staff view threads" on chat_threads
  for select using (
    exists (
      select 1
      from staff_profiles sp
      where sp.user_id = auth.uid()
        and sp.office_id = chat_threads.office_id
    )
  );

create policy "staff insert threads" on chat_threads
  for insert with check (
    auth.role() = 'service_role'
    or exists (
      select 1
      from staff_profiles sp
      where sp.user_id = auth.uid()
        and sp.office_id = chat_threads.office_id
    )
  );

create policy "staff view messages" on chat_messages
  for select using (
    exists (
      select 1
      from chat_threads ct
      join staff_profiles sp on sp.office_id = ct.office_id
      where sp.user_id = auth.uid()
        and ct.id = chat_messages.thread_id
    )
  );

create policy "staff insert messages" on chat_messages
  for insert with check (
    auth.role() = 'service_role'
    or exists (
      select 1
      from chat_threads ct
      join staff_profiles sp on sp.office_id = ct.office_id
      where sp.user_id = auth.uid()
        and ct.id = chat_messages.thread_id
    )
  );

alter table storage.objects enable row level security;

create policy "staff access gemini upload bucket" on storage.objects
  for select using (
    bucket_id = 'gemini-upload-cache'
    and exists (
      select 1
      from staff_profiles sp
      where sp.user_id = auth.uid()
    )
  );

create policy "staff upload gemini cache" on storage.objects
  for insert with check (
    bucket_id = 'gemini-upload-cache'
    and exists (
      select 1
      from staff_profiles sp
      where sp.user_id = auth.uid()
    )
  );

create policy "staff remove gemini cache" on storage.objects
  for delete using (
    bucket_id = 'gemini-upload-cache'
    and exists (
      select 1
      from staff_profiles sp
      where sp.user_id = auth.uid()
    )
  );
