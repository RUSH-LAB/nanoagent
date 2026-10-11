-- Tenancy controls: who may sign up, what each workspace may use, what the
-- assistant has cost, which accounts are suspended, and what platform
-- administrators did. Additive: no existing table or function changes.

-- The platform's rules, one row. Workspace limits below override the defaults.
create table platform_policy (
  id boolean primary key default true check (id),
  -- open: anyone; invite: an address with a pending invitation or on the
  -- allowlist; allowlist: only the allowlist. Entries are addresses or @domains.
  signup_mode text not null default 'invite' check (signup_mode in ('open', 'invite', 'allowlist')),
  signup_allowlist text[] not null default '{}',
  max_workspaces_per_user integer not null default 3 check (max_workspaces_per_user >= 0),
  workspace_storage_bytes bigint not null default 524288000 check (workspace_storage_bytes >= 0),
  workspace_max_members integer not null default 20 check (workspace_max_members >= 1),
  workspace_ai_daily_usd numeric(12, 4) not null default 1 check (workspace_ai_daily_usd >= 0),
  workspace_ai_monthly_usd numeric(12, 4) not null default 10 check (workspace_ai_monthly_usd >= 0),
  member_ai_daily_usd numeric(12, 4) not null default 0.5 check (member_ai_daily_usd >= 0),
  updated_at timestamptz not null default now(),
  updated_by text references app_user(id) on delete set null
);
insert into platform_policy default values;

-- Per-workspace overrides; a null column uses the platform default.
create table workspace_limits (
  workspace_id text primary key references workspace(id) on delete cascade,
  storage_bytes bigint check (storage_bytes >= 0),
  max_members integer check (max_members >= 1),
  ai_daily_usd numeric(12, 4) check (ai_daily_usd >= 0),
  ai_monthly_usd numeric(12, 4) check (ai_monthly_usd >= 0),
  member_ai_daily_usd numeric(12, 4) check (member_ai_daily_usd >= 0),
  updated_at timestamptz not null default now(),
  updated_by text references app_user(id) on delete set null
);

-- A per-account override of max_workspaces_per_user, and suspension.
alter table app_user add column max_workspaces integer check (max_workspaces >= 0);
alter table app_user add column banned_at timestamptz;
alter table app_user add column ban_reason text;

-- One row per assistant call, priced by NanoAgent. `estimated` marks a call
-- whose cost NanoAgent did not report and which is charged at its cap.
create table ai_usage (
  id bigserial primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text references app_user(id) on delete set null,
  at timestamptz not null default now(),
  kind text not null check (kind in ('chat', 'inline', 'complete', 'app', 'task', 'plugin')),
  model text,
  cost_usd numeric(12, 6) not null check (cost_usd >= 0),
  input_tokens integer,
  output_tokens integer,
  estimated boolean not null default false
);
create index ai_usage_workspace_at_idx on ai_usage(workspace_id, at);
create index ai_usage_user_at_idx on ai_usage(user_id, at);

alter table ai_usage enable row level security;
create policy ai_usage_member_read on ai_usage for select
  using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id));
create policy ai_usage_member_insert on ai_usage for insert
  with check (workspace_id = request_workspace_id() and is_workspace_member(workspace_id)
              and user_id = request_user_id());
alter table ai_usage force row level security;

-- Forced row-level security binds the table owner too, which is the role the
-- security-definer functions below run as. These read-only policies are for
-- that role alone (the role running this migration), so the functions can sum
-- spend and storage across workspaces; the runtime role gains nothing.
do $$
begin
  execute format('create policy ai_usage_owner_read on ai_usage for select to %I using (true)', current_user);
  execute format('create policy object_blob_owner_read on object_blob for select to %I using (true)', current_user);
  execute format('create policy fs_content_owner_read on fs_content for select to %I using (true)', current_user);
end $$;

-- What platform administrators did. Written and read only by the server.
create table platform_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id text references app_user(id) on delete set null,
  actor_label text not null,
  action text not null,
  target_type text not null check (target_type in ('user', 'workspace', 'policy')),
  target_id text,
  target_label text,
  detail jsonb
);
create index platform_audit_at_idx on platform_audit(at desc);

-- Fixed-window counters shared by every server process, for Better Auth's
-- sign-in limits and the API's own.
create table rate_limit_bucket (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);
create index rate_limit_bucket_window_idx on rate_limit_bucket(window_start);

-- The limits a workspace runs under: its overrides over the platform defaults.
create or replace function workspace_effective_limits(p_workspace_id text)
returns table(storage_bytes bigint, max_members integer, ai_daily_usd numeric,
              ai_monthly_usd numeric, member_ai_daily_usd numeric)
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(l.storage_bytes, p.workspace_storage_bytes),
         coalesce(l.max_members, p.workspace_max_members),
         coalesce(l.ai_daily_usd, p.workspace_ai_daily_usd),
         coalesce(l.ai_monthly_usd, p.workspace_ai_monthly_usd),
         coalesce(l.member_ai_daily_usd, p.member_ai_daily_usd)
    from public.platform_policy p
    left join public.workspace_limits l on l.workspace_id = p_workspace_id
$$;

-- Bytes a workspace holds: file-system contents and uploaded objects.
create or replace function workspace_storage_used(p_workspace_id text) returns bigint
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((select sum(size) from public.fs_content where workspace_id = p_workspace_id), 0)::bigint
       + coalesce((select sum(byte_size) from public.object_blob where workspace_id = p_workspace_id), 0)::bigint
$$;

-- Refuses a write that would take a workspace past its storage limit, whichever
-- code path writes the bytes.
create or replace function enforce_workspace_storage() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  added bigint;
  used bigint;
  allowed bigint;
begin
  if tg_table_name = 'fs_content' then
    added := new.size - case when tg_op = 'UPDATE' then old.size else 0 end;
  else
    added := new.byte_size - case when tg_op = 'UPDATE' then old.byte_size else 0 end;
  end if;
  if added <= 0 then return new; end if;
  select storage_bytes into allowed from public.workspace_effective_limits(new.workspace_id);
  used := public.workspace_storage_used(new.workspace_id);
  if used + added > allowed then
    raise exception 'storage-limit-reached'
      using errcode = 'P0001',
            detail = format('used=%s added=%s limit=%s', used, added, allowed),
            hint = 'This workspace has reached its storage limit.';
  end if;
  return new;
end $$;
create trigger fs_content_storage_limit before insert or update on fs_content
  for each row execute function enforce_workspace_storage();
create trigger object_blob_storage_limit before insert or update on object_blob
  for each row execute function enforce_workspace_storage();

-- Refuses a membership past the workspace's member limit. Better Auth checks the
-- same limit first with a readable error; this holds for every other path.
create or replace function enforce_workspace_members() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  members integer;
  allowed integer;
begin
  select max_members into allowed from public.workspace_effective_limits(new.workspace_id);
  select count(*) into members from public.workspace_member where workspace_id = new.workspace_id;
  if members >= allowed then
    raise exception 'member-limit-reached'
      using errcode = 'P0001', hint = 'This workspace has reached its member limit.';
  end if;
  return new;
end $$;
create trigger workspace_member_limit before insert on workspace_member
  for each row execute function enforce_workspace_members();

-- Every workspace with its owner, size, and spend, for platform administrators.
create or replace function platform_workspace_overview()
returns table(id text, name text, slug text, status text, created_at timestamptz,
              owner_id text, owner_email text, member_count integer, storage_used bigint,
              ai_month_usd numeric, storage_bytes bigint, max_members integer,
              ai_daily_usd numeric, ai_monthly_usd numeric, member_ai_daily_usd numeric,
              overridden boolean)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.platform_admin pa where pa.user_id = public.request_user_id()) then
    raise exception 'platform-admin-required' using errcode = '42501';
  end if;
  return query
  select w.id, w.name, w.slug, w.status, w.created_at, o.user_id, u.email,
         (select count(*)::int from public.workspace_member m where m.workspace_id = w.id),
         public.workspace_storage_used(w.id),
         coalesce((select sum(a.cost_usd) from public.ai_usage a
                    where a.workspace_id = w.id and a.at >= date_trunc('month', now())), 0),
         e.storage_bytes, e.max_members, e.ai_daily_usd, e.ai_monthly_usd, e.member_ai_daily_usd,
         exists (select 1 from public.workspace_limits l where l.workspace_id = w.id)
    from public.workspace w
    left join lateral (select m.user_id from public.workspace_member m
                        where m.workspace_id = w.id and m.role = 'owner'
                        order by m.created_at, m.id limit 1) o on true
    left join public.app_user u on u.id = o.user_id
    cross join lateral public.workspace_effective_limits(w.id) e
   order by w.created_at desc, w.id;
end $$;

-- Archive or restore any workspace, for platform administrators.
create or replace function platform_set_workspace_status(p_workspace_id text, p_status text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare changed integer;
begin
  if not exists (select 1 from public.platform_admin pa where pa.user_id = public.request_user_id()) then
    raise exception 'platform-admin-required' using errcode = '42501';
  end if;
  update public.workspace
     set status = p_status,
         archived_at = case when p_status = 'archived' then now() else null end
   where id = p_workspace_id and status <> p_status;
  get diagnostics changed = row_count;
  return changed > 0;
end $$;

-- Assistant spend per account over the last 30 days, for platform administrators.
create or replace function platform_user_ai_spend()
returns table(user_id text, ai_30d_usd numeric)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.platform_admin pa where pa.user_id = public.request_user_id()) then
    raise exception 'platform-admin-required' using errcode = '42501';
  end if;
  return query
  select a.user_id, sum(a.cost_usd) from public.ai_usage a
   where a.user_id is not null and a.at >= now() - interval '30 days'
   group by a.user_id;
end $$;

-- The workspaces an account owns, with how many other members each has, so an
-- account is never deleted out from under a workspace other people use.
create or replace function owned_workspaces(p_user_id text)
returns table(id text, name text, slug text, other_members integer, other_owners integer)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if p_user_id is distinct from public.request_user_id()
     and not exists (select 1 from public.platform_admin pa where pa.user_id = public.request_user_id()) then
    raise exception 'owned-workspaces-forbidden' using errcode = '42501';
  end if;
  return query
  select w.id, w.name, w.slug,
         (select count(*)::int from public.workspace_member m2 where m2.workspace_id = w.id and m2.user_id <> p_user_id),
         (select count(*)::int from public.workspace_member m3
           where m3.workspace_id = w.id and m3.user_id <> p_user_id and m3.role = 'owner')
    from public.workspace_member m join public.workspace w on w.id = m.workspace_id
   where m.user_id = p_user_id and m.role = 'owner'
   order by w.created_at, w.id;
end $$;

-- Whether an address holds a live invitation, which is what invite-only sign-up
-- asks before an account exists to scope the question to.
create or replace function signup_invitation_exists(p_email text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.workspace_invitation
                  where lower(email) = lower(p_email) and status = 'pending' and expires_at > now())
$$;

revoke execute on function signup_invitation_exists(text) from public;
revoke execute on function workspace_effective_limits(text) from public;
revoke execute on function workspace_storage_used(text) from public;
revoke execute on function enforce_workspace_storage() from public;
revoke execute on function enforce_workspace_members() from public;
revoke execute on function platform_workspace_overview() from public;
revoke execute on function platform_set_workspace_status(text, text) from public;
revoke execute on function platform_user_ai_spend() from public;
revoke execute on function owned_workspaces(text) from public;
