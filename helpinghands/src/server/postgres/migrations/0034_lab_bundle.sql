-- Mochi Lab without its window (routes/lab.js): the newest bundle for each
-- target, the gzip tarball the one-line install unpacks on a member's Mac.
-- Not workspace data: readable by every signed-in user, and written only by
-- the upload path, which no user makes. A bundle is 40-90 MB, so its bytes are
-- rows of at most 4 MiB, sent on one at a time; an upload replaces the
-- target's previous bundle, its chunks with it, in one transaction.
create or replace function request_lab_upload() returns boolean language sql stable as $$
  select coalesce(current_setting('app.lab_upload', true) = 'on', false)
$$;

create table lab_bundle (
  target text primary key check (target in ('aarch64-apple-darwin', 'x86_64-apple-darwin')),
  -- Which upload the chunks are: a download reads one upload's chunks only.
  upload_id uuid not null unique,
  stamp text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint not null check (size > 0),
  uploaded_at timestamptz not null default now()
);

create table lab_bundle_chunk (
  -- Checked at commit: an upload writes its chunks before its bundle row.
  upload_id uuid not null references lab_bundle(upload_id) on delete cascade deferrable initially deferred,
  seq integer not null check (seq >= 0),
  data bytea not null,
  primary key (upload_id, seq)
);

alter table lab_bundle enable row level security;
create policy lab_bundle_read on lab_bundle for select using (request_user_id() is not null or request_lab_upload());
create policy lab_bundle_insert on lab_bundle for insert with check (request_lab_upload());
create policy lab_bundle_delete on lab_bundle for delete using (request_lab_upload());
alter table lab_bundle force row level security;

alter table lab_bundle_chunk enable row level security;
create policy lab_bundle_chunk_read on lab_bundle_chunk for select using (request_user_id() is not null);
create policy lab_bundle_chunk_insert on lab_bundle_chunk for insert with check (request_lab_upload());
create policy lab_bundle_chunk_delete on lab_bundle_chunk for delete using (request_lab_upload());
alter table lab_bundle_chunk force row level security;
