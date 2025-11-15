alter table file_store_files add column if not exists storage_bucket text;
alter table file_store_files add column if not exists storage_path text;
alter table file_store_files add column if not exists storage_object_path text;
