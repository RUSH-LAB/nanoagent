-- Better Auth maps directly onto these canonical product tables. Its IDs are
-- opaque text; workspace IDs are immutable and never derived from slugs.
create table app_user (
  id text primary key,
  email text not null,
  display_name text not null,
  email_verified boolean not null default false,
  image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_user_email_normalized check (email = lower(btrim(email)))
);
create unique index app_user_email_uidx on app_user (lower(email));

create table auth_session (
  id text primary key,
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  ip_address text,
  user_agent text,
  user_id text not null references app_user(id) on delete cascade,
  "activeOrganizationId" text
);
create index auth_session_user_idx on auth_session(user_id);

create table auth_account (
  id text primary key,
  issuer text not null,
  account_id text not null,
  provider_id text not null,
  user_id text not null references app_user(id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (issuer, account_id)
);
create index auth_account_user_idx on auth_account(user_id);

create table auth_verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index auth_verification_identifier_idx on auth_verification(identifier);

create table workspace (
  id text primary key,
  name text not null check (length(btrim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  logo text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by text references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  archived_at timestamptz
);
create unique index workspace_slug_uidx on workspace (lower(slug));

create table workspace_member (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null references app_user(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index workspace_member_user_idx on workspace_member(user_id);

create table workspace_invitation (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  email text not null check (email = lower(btrim(email))),
  role text not null check (role in ('owner', 'editor', 'viewer')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  invited_by text not null references app_user(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index workspace_invitation_lookup_idx on workspace_invitation(workspace_id, lower(email), status);

create table workspace_settings (
  workspace_id text primary key references workspace(id) on delete cascade,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table user_preferences (
  user_id text primary key references app_user(id) on delete cascade,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table workspace_member_preferences (
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null references app_user(id) on delete cascade,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table document (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  path text not null check (path <> '' and path !~ '(^/|\\\\|(^|/)\.\.(/|$))'),
  title text,
  markdown text not null default '',
  ydoc bytea,
  visibility text not null default 'org' check (visibility in ('org', 'private')),
  created_by text references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, workspace_id)
);
create unique index document_workspace_path_uidx on document(workspace_id, path) where deleted_at is null;
create index document_workspace_idx on document(workspace_id) where deleted_at is null;

create table document_version (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  document_id text not null,
  seq bigint not null,
  markdown text not null,
  author_id text references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (document_id, seq),
  foreign key (document_id, workspace_id) references document(id, workspace_id) on delete cascade
);

create table asset (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  object_key text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_by text references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, object_key)
);

create table reference (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  citation_key text not null,
  value jsonb not null,
  created_by text references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, citation_key)
);

create table store_item (
  workspace_id text not null references workspace(id) on delete cascade,
  owner_id text references app_user(id) on delete cascade,
  domain text not null,
  key text not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index store_item_identity_uidx on store_item(workspace_id, domain, coalesce(owner_id, ''), key);
create index store_item_scope_idx on store_item(workspace_id, domain, coalesce(owner_id, ''));

create table channel (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  kind text not null check (kind in ('public', 'private', 'dm')),
  name text,
  topic text,
  dm_key text,
  created_by text references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
alter table channel add constraint channel_id_workspace_unique unique (id, workspace_id);
create unique index channel_workspace_name_uidx on channel(workspace_id, name) where name is not null;
create unique index channel_workspace_dm_uidx on channel(workspace_id, dm_key) where dm_key is not null;
create table channel_member (
  workspace_id text not null references workspace(id) on delete cascade,
  channel_id text not null,
  user_id text not null references app_user(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_seq bigint not null default 0,
  primary key (channel_id, user_id),
  foreign key (channel_id, workspace_id) references channel(id, workspace_id) on delete cascade
);
create table message (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  seq bigint not null,
  channel_id text not null,
  user_id text not null references app_user(id),
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  unique (channel_id, seq),
  foreign key (channel_id, workspace_id) references channel(id, workspace_id) on delete cascade
);

create table workspace_audit (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  action text not null,
  actor_id text references app_user(id) on delete set null,
  actor_label text not null,
  target_id text references app_user(id) on delete set null,
  target_label text not null,
  detail jsonb,
  at timestamptz not null default now()
);
create index workspace_audit_workspace_at_idx on workspace_audit(workspace_id, at desc);

create table platform_admin (
  user_id text primary key references app_user(id) on delete cascade,
  granted_at timestamptz not null default now()
);

-- Remote object deletion cannot be part of the workspace SQL transaction.
-- Queue every object key before cascading its asset metadata, then let the
-- application retry idempotent deletes until the queue is empty.
create table object_deletion (
  id text primary key,
  workspace_id text not null,
  object_key text not null unique,
  requested_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text
);

create or replace function request_user_id() returns text language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')
$$;
create or replace function request_workspace_id() returns text language sql stable as $$
  select nullif(current_setting('app.workspace_id', true), '')
$$;
create or replace function is_workspace_member(p_workspace_id text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.workspace_member where workspace_id = p_workspace_id and user_id = public.request_user_id())
$$;
create or replace function request_workspace_role(p_workspace_id text) returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select role from public.workspace_member where workspace_id = p_workspace_id and user_id = public.request_user_id() limit 1
$$;

create or replace function create_workspace_with_owner(p_name text, p_slug text)
returns workspace language plpgsql security definer set search_path = pg_catalog, public as $$
declare created workspace;
begin
  if request_user_id() is null then raise exception 'app.user_id is required'; end if;
  insert into workspace(id, name, slug, created_by)
    values (gen_random_uuid()::text, p_name, lower(p_slug), request_user_id()) returning * into created;
  perform set_config('app.workspace_id', created.id, true);
  insert into workspace_member(id, workspace_id, user_id, role)
    values (gen_random_uuid()::text, created.id, request_user_id(), 'owner');
  insert into workspace_settings(workspace_id) values (created.id);
  return created;
end $$;

create or replace function invitation_preview(p_invitation_id text)
returns table(id text, email text, role text, status text, expires_at timestamptz,
              workspace_id text, workspace_name text, inviter_name text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select i.id, i.email, i.role, i.status, i.expires_at, i.workspace_id,
         w.name, coalesce(u.display_name, u.email)
    from public.workspace_invitation i
    join public.workspace w on w.id = i.workspace_id
    left join public.app_user u on u.id = i.invited_by
   where i.id = p_invitation_id
$$;

create or replace function accept_workspace_invitation(p_invitation_id text)
returns workspace_member language plpgsql security definer set search_path = pg_catalog, public as $$
declare invited workspace_invitation;
declare actor_email text;
declare joined workspace_member;
begin
  select email into actor_email from app_user where id = request_user_id();
  select * into invited from workspace_invitation where id = p_invitation_id for update;
  if invited.id is null or invited.status <> 'pending' or invited.expires_at <= now()
     or lower(invited.email) <> lower(actor_email) then
    raise exception 'invitation-not-found';
  end if;
  insert into workspace_member(id, workspace_id, user_id, role)
    values (gen_random_uuid()::text, invited.workspace_id, request_user_id(), invited.role)
    on conflict (workspace_id, user_id) do update set role = excluded.role
    returning * into joined;
  update workspace_invitation set status = 'accepted' where id = invited.id;
  return joined;
end $$;

create or replace function list_scheduled_workspaces()
returns table(id text, slug text, name text, owner_id text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select w.id, w.slug, w.name,
         (select m.user_id from public.workspace_member m
           where m.workspace_id = w.id and m.role = 'owner' order by m.created_at, m.id limit 1)
    from public.workspace w where w.status = 'active' order by w.created_at, w.id
$$;

create or replace function list_user_workspaces(p_user_id text)
returns table(id text, name text, slug text, role text, joined_at timestamptz, member_count integer)
language sql stable security definer set search_path = pg_catalog, public as $$
  select w.id, w.name, w.slug, m.role, m.created_at,
         (select count(*)::int from public.workspace_member m2 where m2.workspace_id = w.id)
    from public.workspace_member m join public.workspace w on w.id = m.workspace_id
   where p_user_id = public.request_user_id() and m.user_id = p_user_id and w.status = 'active'
   order by m.created_at, m.id
$$;

create or replace function delete_workspace_and_queue_assets(p_workspace_id text)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare queued integer;
begin
  if request_workspace_role(p_workspace_id) <> 'owner' then
    raise exception 'workspace-not-found-or-forbidden' using errcode = '42501';
  end if;
  insert into object_deletion(id, workspace_id, object_key)
    select gen_random_uuid()::text, workspace_id, object_key from asset
     where workspace_id = p_workspace_id
    on conflict (object_key) do nothing;
  get diagnostics queued = row_count;
  delete from workspace where id = p_workspace_id;
  return queued;
end $$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. These
-- security-definer entry points are application internals; the migration
-- runner grants them only to the dedicated runtime role after migration.
revoke execute on function is_workspace_member(text) from public;
revoke execute on function request_workspace_role(text) from public;
revoke execute on function create_workspace_with_owner(text, text) from public;
revoke execute on function invitation_preview(text) from public;
revoke execute on function accept_workspace_invitation(text) from public;
revoke execute on function list_scheduled_workspaces() from public;
revoke execute on function list_user_workspaces(text) from public;
revoke execute on function delete_workspace_and_queue_assets(text) from public;

-- Identity/session tables stay outside RLS because Better Auth performs their
-- access. All product data is protected again in PostgreSQL.
alter table workspace enable row level security;
alter table workspace_member enable row level security;
alter table workspace_invitation enable row level security;
alter table workspace_settings enable row level security;
alter table workspace_member_preferences enable row level security;
alter table document enable row level security;
alter table document_version enable row level security;
alter table asset enable row level security;
alter table reference enable row level security;
alter table store_item enable row level security;
alter table channel enable row level security;
alter table channel_member enable row level security;
alter table message enable row level security;
alter table workspace_audit enable row level security;
alter table user_preferences enable row level security;

create policy workspace_member_read on workspace for select using (is_workspace_member(id));
create policy workspace_owner_update on workspace for update using (request_workspace_role(id) = 'owner') with check (request_workspace_role(id) = 'owner');
create policy workspace_owner_delete on workspace for delete using (request_workspace_role(id) = 'owner');
create policy workspace_member_read on workspace_member for select using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id));
create policy workspace_member_self_discovery on workspace_member for select using (user_id = request_user_id());
create policy workspace_member_insert on workspace_member for insert with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy workspace_member_update on workspace_member for update using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner') with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy workspace_member_delete on workspace_member for delete using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy workspace_invitation_read on workspace_invitation for select using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy workspace_invitation_write on workspace_invitation for all using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner') with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy workspace_settings_read on workspace_settings for select using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id));
create policy workspace_settings_write on workspace_settings for all using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner') with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy workspace_member_preferences_scope on workspace_member_preferences for all using (workspace_id = request_workspace_id() and user_id = request_user_id() and is_workspace_member(workspace_id)) with check (workspace_id = request_workspace_id() and user_id = request_user_id() and is_workspace_member(workspace_id));
create policy document_read on document for select using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id) and (visibility = 'org' or created_by = request_user_id()));
create policy document_insert on document for insert with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor') and created_by = request_user_id());
create policy document_update on document for update using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor')) with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor'));
create policy document_delete on document for delete using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy document_version_read on document_version for select using (workspace_id = request_workspace_id() and exists (select 1 from document d where d.id = document_id and d.workspace_id = document_version.workspace_id));
create policy document_version_insert on document_version for insert with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor') and author_id = request_user_id());
create policy document_version_delete on document_version for delete using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy asset_read on asset for select using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id));
create policy asset_insert on asset for insert with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor') and created_by = request_user_id());
create policy asset_delete on asset for delete using (
  workspace_id = request_workspace_id()
  and (request_workspace_role(workspace_id) = 'owner'
    or (request_workspace_role(workspace_id) = 'editor' and created_by = request_user_id()))
);
create policy reference_read on reference for select using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id));
create policy reference_insert on reference for insert with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor') and created_by = request_user_id());
create policy reference_update on reference for update using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor')) with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor'));
create policy reference_delete on reference for delete using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy store_item_read on store_item for select using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id) and (owner_id is null or owner_id = request_user_id()));
create policy store_item_write on store_item for all using (
  workspace_id = request_workspace_id() and is_workspace_member(workspace_id)
  and (owner_id = request_user_id() or request_workspace_role(workspace_id) in ('owner', 'editor')
    or domain in ('analytics', 'plugin:bibliography:annotations'))
) with check (
  workspace_id = request_workspace_id() and is_workspace_member(workspace_id)
  and (owner_id = request_user_id() or request_workspace_role(workspace_id) in ('owner', 'editor')
    or domain in ('analytics', 'plugin:bibliography:annotations'))
);
create policy channel_read on channel for select using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id));
create policy channel_insert on channel for insert with check (
  workspace_id = request_workspace_id()
  and (request_workspace_role(workspace_id) in ('owner', 'editor') or (kind = 'dm' and created_by = request_user_id()))
);
create policy channel_update on channel for update using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor')) with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor'));
create policy channel_delete on channel for delete using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy channel_member_scope on channel_member for all using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id)) with check (workspace_id = request_workspace_id() and is_workspace_member(workspace_id));
create policy message_read on message for select using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id));
create policy message_insert on message for insert with check (workspace_id = request_workspace_id() and user_id = request_user_id() and is_workspace_member(workspace_id));
create policy message_update on message for update using (workspace_id = request_workspace_id() and user_id = request_user_id()) with check (workspace_id = request_workspace_id() and user_id = request_user_id());
create policy message_delete on message for delete using (workspace_id = request_workspace_id() and user_id = request_user_id());
create policy workspace_audit_read on workspace_audit for select using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
create policy workspace_audit_insert on workspace_audit for insert with check (workspace_id = request_workspace_id() and actor_id = request_user_id());
create policy user_preferences_scope on user_preferences for all using (user_id = request_user_id()) with check (user_id = request_user_id());

alter table workspace_member_preferences force row level security;
alter table document force row level security;
alter table document_version force row level security;
alter table asset force row level security;
alter table reference force row level security;
alter table store_item force row level security;
alter table channel force row level security;
alter table channel_member force row level security;
alter table message force row level security;
alter table workspace_audit force row level security;
alter table user_preferences force row level security;
