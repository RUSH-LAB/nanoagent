-- Uploaded PDFs and content assets belong in the same durable database as
-- their metadata. Keeping the bytes here prevents a database branch or deploy
-- from pointing at files that exist only on one machine's local filesystem.
create table object_blob (
  object_key text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  body bytea not null,
  content_type text not null default 'application/octet-stream',
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (object_key like workspace_id || '/%'),
  check (byte_size = octet_length(body))
);
create index object_blob_workspace_idx on object_blob(workspace_id);

alter table object_blob enable row level security;
create policy object_blob_workspace_scope on object_blob for all
  using (workspace_id = request_workspace_id())
  with check (workspace_id = request_workspace_id());
alter table object_blob force row level security;
