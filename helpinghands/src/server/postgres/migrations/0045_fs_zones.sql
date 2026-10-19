-- App state moves under folders starting with a dot, which the Explorer and the
-- sync clients leave out, and a member's plugin folders get names a person
-- reads (docs/plans/filesystem-layout.md):
--
--   chat/…                                  .chat/…
--   .plugins/blobs/<id>                     .plugins/.imported/<id>     imported blobs, which name no plugin
--   .plugins/<plugin>/<blob>                .plugins/<plugin>/blobs/<blob>
--   apps/<glossary|schedule|…>/<key>.json   .apps/<…>/<key>.json
--   apps/<plugin>/<collection>/<key>.json   .plugins/<plugin>/records/<collection>/<key>.json
--   home/<user>/<bookmarks|tasks|…>/<key>.json   home/<user>/.apps/<…>/<key>.json
--   home/<user>/agent/…                     home/<user>/Plugins/…
--   home/<user>/files/…                     home/<user>/From earlier runs/…
--
-- Records move one file at a time, so a member's own files in a folder of the
-- same name stay where they are; a folder left empty by them goes to the trash.
-- Nothing moves if any target is taken. Every create, move and delete is
-- logged, by no one, so every client following the change log does the same.
create or replace function fs_may_write(p_workspace_id text, p_path text) returns boolean
language sql stable as $$
  select request_workspace_role(p_workspace_id) in ('owner', 'editor')
      or (is_workspace_member(p_workspace_id) and (
        left(p_path, 6) = '.chat/'
        or p_path = '.chat'
        or p_path = 'home/' || request_user_id()
        or left(p_path, length(request_user_id()) + 6) = 'home/' || request_user_id() || '/'))
$$;

alter table fs_node no force row level security;
alter table fs_change no force row level security;

create temporary table zone_move on commit drop as
  select * from (
    select n.id, n.workspace_id, n.path as from_path, n.kind, n.access_explicit,
      case
        when n.path ~ '^chat(/|$)' then '.' || n.path
        when n.path ~ '^\.plugins/blobs(/|$)' then regexp_replace(n.path, '^\.plugins/blobs', '.plugins/.imported')
        when n.kind = 'file' and n.path ~ '^\.plugins/[^/.][^/]*/[^/]+$'
          then regexp_replace(n.path, '^(\.plugins/[^/]+)/', '\1/blobs/')
        when n.kind = 'file' and n.path ~ '^apps/(glossary|schedule|whiteboards|agents)/[^/]+\.json$' then '.' || n.path
        when n.kind = 'file' and n.path ~ '^apps/[^/]+/.+\.json$'
          then regexp_replace(n.path, '^apps/([^/]+)/', '.plugins/\1/records/')
        when n.kind = 'file' and n.path ~ '^home/[^/]+/(bookmarks|flashcards|tasks|reading-lists|notes|quicknotes)/[^/]+\.json$'
          then regexp_replace(n.path, '^(home/[^/]+)/', '\1/.apps/')
        when n.path ~ '^home/[^/]+/agent(/|$)' then regexp_replace(n.path, '^(home/[^/]+)/agent', '\1/Plugins')
        when n.path ~ '^home/[^/]+/files(/|$)' then regexp_replace(n.path, '^(home/[^/]+)/files', '\1/From earlier runs')
      end as path
    from fs_node n
    where n.deleted_at is null
  ) moves
  where path is not null;

do $$
declare
  taken text;
begin
  select string_agg(n.workspace_id || ':' || n.path, ', ' order by n.workspace_id, n.path) into taken
  from zone_move m
  join fs_node n on n.workspace_id = m.workspace_id and n.path = m.path and n.deleted_at is null
  where n.id not in (select id from zone_move);
  if taken is not null then
    raise exception 'Cannot lay out the file system: these paths are taken: %', taken;
  end if;
end
$$;

update fs_node n set path = m.path, updated_at = now() from zone_move m where n.id = m.id;

-- The folders the moves need that do not exist yet, private in a home and the
-- workspace's elsewhere. One in a home is owned by whoever owns the home: no
-- one when the home's member is gone, as deleting a user leaves it.
create temporary table zone_folder on commit drop as
  select gen_random_uuid()::text as id, a.workspace_id, a.path,
    case when a.path ~ '^home/[^/]+/' then 'private' else 'workspace' end as access,
    (select h.owner_id from fs_node h
      where h.workspace_id = a.workspace_id and h.deleted_at is null
        and h.path = substring(a.path from '^(home/[^/]+)/')) as owner_id
  from (
    select distinct m.workspace_id, array_to_string((string_to_array(m.path, '/'))[1:depth], '/') as path
    from zone_move m, generate_series(1, array_length(string_to_array(m.path, '/'), 1) - 1) depth
  ) a
  where not exists (
    select 1 from fs_node n where n.workspace_id = a.workspace_id and n.path = a.path and n.deleted_at is null
  );

insert into fs_node(id, workspace_id, path, kind, access, access_explicit, owner_id, rev)
  select id, workspace_id, path, 'folder', access, false, owner_id, 0 from zone_folder;

-- A record moved into a new folder takes its access, unless it has its own.
update fs_node n set access = f.access, owner_id = coalesce(f.owner_id, n.owner_id), share_root = null
  from zone_move m, zone_folder f
  where n.id = m.id and not m.access_explicit
    and f.workspace_id = m.workspace_id and f.path = regexp_replace(m.path, '/[^/]+$', '');

-- Folders the records left empty, deepest first.
create temporary table zone_emptied (id text, workspace_id text, path text) on commit drop;
do $$
declare
  found int;
begin
  loop
    with emptied as (
      update fs_node n set deleted_at = now()
      where n.deleted_at is null and n.kind = 'folder'
        and (n.path ~ '^apps(/|$)' or n.path ~ '^home/[^/]+/(bookmarks|flashcards|tasks|reading-lists|notes|quicknotes)$')
        and not exists (
          select 1 from fs_node c
          where c.workspace_id = n.workspace_id and c.deleted_at is null and left(c.path, length(n.path) + 1) = n.path || '/')
      returning n.id, n.workspace_id, n.path
    )
    insert into zone_emptied select * from emptied;
    get diagnostics found = row_count;
    exit when found = 0;
  end loop;
end
$$;

with logged as (
  insert into fs_change(workspace_id, node_id, op, path, from_path, kind, content_hash, access, actor_id)
  select n.workspace_id, n.id, change.op, n.path, change.from_path, n.kind, n.content_hash, n.access, null
  from (
    select id, 'create' as op, null as from_path, 0 as phase, path as sort from zone_folder
    union all
    select id, 'move', from_path, 1, path from zone_move
    union all
    select id, 'delete', null, 2, path from zone_emptied
  ) change
  join fs_node n on n.id = change.id
  order by n.workspace_id, change.phase, case when change.phase = 2 then '' else change.sort end, change.sort desc
  returning node_id, seq
)
update fs_node n set rev = l.seq from logged l where n.id = l.node_id;

alter table fs_node force row level security;
alter table fs_change force row level security;
