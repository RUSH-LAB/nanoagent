-- A workspace takes any number of members: the member limit goes from the
-- platform's defaults, from each workspace's own limits, and from the trigger
-- that held it. The two functions that report limits are made again without it.
drop trigger workspace_member_limit on workspace_member;
drop function enforce_workspace_members();
drop function platform_workspace_overview();
drop function workspace_effective_limits(text);
alter table platform_policy drop column workspace_max_members;
alter table workspace_limits drop column max_members;

create function workspace_effective_limits(p_workspace_id text)
returns table(storage_bytes bigint, ai_daily_usd numeric, ai_monthly_usd numeric, member_ai_daily_usd numeric)
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(l.storage_bytes, p.workspace_storage_bytes),
         coalesce(l.ai_daily_usd, p.workspace_ai_daily_usd),
         coalesce(l.ai_monthly_usd, p.workspace_ai_monthly_usd),
         coalesce(l.member_ai_daily_usd, p.member_ai_daily_usd)
    from public.platform_policy p
    left join public.workspace_limits l on l.workspace_id = p_workspace_id
$$;

create function platform_workspace_overview()
returns table(id text, name text, slug text, status text, created_at timestamptz,
              owner_id text, owner_email text, member_count integer, storage_used bigint,
              ai_month_usd numeric, storage_bytes bigint,
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
         e.storage_bytes, e.ai_daily_usd, e.ai_monthly_usd, e.member_ai_daily_usd,
         exists (select 1 from public.workspace_limits l where l.workspace_id = w.id)
    from public.workspace w
    left join lateral (select m.user_id from public.workspace_member m
                        where m.workspace_id = w.id and m.role = 'owner'
                        order by m.created_at, m.id limit 1) o on true
    left join public.app_user u on u.id = o.user_id
    cross join lateral public.workspace_effective_limits(w.id) e
   order by w.created_at desc, w.id;
end $$;

revoke execute on function workspace_effective_limits(text) from public;
revoke execute on function platform_workspace_overview() from public;

-- Mochi signs in only with GitHub (server/auth.js), so an account with no
-- GitHub sign-in is one no one can sign in to, a test's or one from before, and
-- it is deleted with everything that cascades from it. One that owns a
-- workspace or administers the platform is not, and stops the migration: hand
-- those on first.
do $$
declare
  blocked text;
begin
  select string_agg(u.email, ', ' order by u.email) into blocked
    from app_user u
   where not exists (select 1 from auth_account a where a.user_id = u.id and a.provider_id = 'github')
     and (exists (select 1 from platform_admin p where p.user_id = u.id)
          or exists (select 1 from workspace_member m where m.user_id = u.id and m.role = 'owner'));
  if blocked is not null then
    raise exception 'Accounts without GitHub own a workspace or administer the platform: %', blocked;
  end if;
end $$;
delete from app_user u
 where not exists (select 1 from auth_account a where a.user_id = u.id and a.provider_id = 'github');
