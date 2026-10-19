-- A member's home, home/<user>, is always a folder private to that member
-- (docs/plans/filesystem-layout.md). fs/store.js made a home private only when
-- its own member made it, so an editor writing home/<bob>/x before Bob had a
-- home made Bob's home with the workspace's access, and every member could read
-- what Bob kept there after. The database now refuses any home that is not a
-- folder private to and owned by its member, and any move of one; a node inside
-- a private home already needs its owner (fs_node_insert, fs_node_update).
-- Homes made before are repaired, with each node whose access changes logged.
create or replace function fs_home_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.path ~ '^home/[^/]+$' and new.path <> old.path then
    raise exception 'The home folder % cannot move', old.path using errcode = 'check_violation';
  end if;
  if new.path ~ '^home/[^/]+$' and new.deleted_at is null
     and (new.kind <> 'folder' or new.access <> 'private' or new.owner_id is distinct from substring(new.path from 6)) then
    raise exception '% is the home of %, a folder private to them', new.path, substring(new.path from 6)
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function fs_home_guard() from public;

-- Not on owner_id: deleting an account sets the owner of its nodes to null.
create trigger fs_node_home_guard before insert or update of path, kind, access, deleted_at on fs_node
  for each row execute function fs_home_guard();

alter table fs_node no force row level security;
alter table fs_change no force row level security;

create temporary table home_repair on commit drop as
  select h.workspace_id, h.path as home, substring(h.path from 6) as owner
  from fs_node h
  join app_user u on u.id = substring(h.path from 6)
  where h.deleted_at is null and h.path ~ '^home/[^/]+$'
    and (h.access <> 'private' or h.owner_id is distinct from substring(h.path from 6));

-- A home whose member has no account any more is not repaired here: the
-- trigger would refuse its owner, and no one can sign in to read it as theirs.
update fs_node n set access = 'private', access_explicit = true, owner_id = r.owner, share_root = null, updated_at = now()
  from home_repair r where n.workspace_id = r.workspace_id and n.path = r.home;

-- Inside a repaired home, a node inherits privacy from it unless it, or a
-- folder between it and the home, has access of its own.
create temporary table home_inherits on commit drop as
  select n.id
  from fs_node n
  join home_repair r on n.workspace_id = r.workspace_id and left(n.path, length(r.home) + 1) = r.home || '/'
  where not n.access_explicit
    and not exists (
      select 1 from fs_node a
      where a.workspace_id = n.workspace_id and a.deleted_at is null and a.access_explicit
        and left(a.path, length(r.home) + 1) = r.home || '/'
        and left(n.path, length(a.path) + 1) = a.path || '/');

update fs_node n set access = 'private', owner_id = r.owner, share_root = null, updated_at = now()
  from home_inherits i, home_repair r
  where n.id = i.id and n.workspace_id = r.workspace_id and left(n.path, length(r.home) + 1) = r.home || '/';

with logged as (
  insert into fs_change(workspace_id, node_id, op, path, kind, content_hash, access, actor_id)
  select n.workspace_id, n.id, 'access', n.path, n.kind, n.content_hash, n.access, null
  from fs_node n
  join home_repair r on n.workspace_id = r.workspace_id
    and (n.path = r.home or n.id in (select id from home_inherits))
  where n.deleted_at is null
  order by n.workspace_id, n.path
  returning node_id, seq
)
update fs_node n set rev = l.seq from logged l where n.id = l.node_id;

alter table fs_node force row level security;
alter table fs_change force row level security;
