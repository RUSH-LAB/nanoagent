-- A class is up to 50 people, so a workspace takes 50 members unless an
-- administrator set more.
alter table platform_policy alter column workspace_max_members set default 50;
update platform_policy set workspace_max_members = 50 where workspace_max_members < 50;

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
