-- Everything of one plugin in a member's home is in one folder
-- (docs/plans/filesystem-layout.md):
--
--   home/<user>/Plugins/<plugin>/…          home/<user>/Plugins/<plugin>/files/…   what each run is given and writes
--   home/<user>/Chats/<plugin>/<chat>/…     home/<user>/Plugins/<plugin>/chats/<chat>/…
--
-- A session names its chat.json by node id (plugin_session.chat_file), so it
-- follows its chat. Folders left empty go to the trash. Nothing moves if any
-- target is taken. Every create, move and delete is logged, by no one, so
-- every client following the change log does the same.
alter table fs_node no force row level security;
alter table fs_change no force row level security;

create temporary table plugin_move on commit drop as
  select * from (
    select n.id, n.workspace_id, n.path as from_path, n.kind,
      case
        when n.path ~ '^home/[^/]+/Plugins/[^/]+/.+$'
          then regexp_replace(n.path, '^(home/[^/]+/Plugins/[^/]+)/', '\1/files/')
        when n.path ~ '^home/[^/]+/Chats/[^/]+/.+$'
          then regexp_replace(n.path, '^(home/[^/]+)/Chats/([^/]+)/', '\1/Plugins/\2/chats/')
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
  from plugin_move m
  join fs_node n on n.workspace_id = m.workspace_id and n.path = m.path and n.deleted_at is null
  where n.id not in (select id from plugin_move);
  if taken is not null then
    raise exception 'Cannot move the plugin folders: these paths are taken: %', taken;
  end if;
end
$$;

update fs_node n set path = m.path, updated_at = now() from plugin_move m where n.id = m.id;

-- The folders the moves need that do not exist yet, private to the home's owner.
create temporary table plugin_folder on commit drop as
  select gen_random_uuid()::text as id, a.workspace_id, a.path,
    (select h.owner_id from fs_node h
      where h.workspace_id = a.workspace_id and h.deleted_at is null
        and h.path = substring(a.path from '^(home/[^/]+)/')) as owner_id
  from (
    select distinct m.workspace_id, array_to_string((string_to_array(m.path, '/'))[1:depth], '/') as path
    from plugin_move m, generate_series(1, array_length(string_to_array(m.path, '/'), 1) - 1) depth
  ) a
  where not exists (
    select 1 from fs_node n where n.workspace_id = a.workspace_id and n.path = a.path and n.deleted_at is null
  );

insert into fs_node(id, workspace_id, path, kind, access, access_explicit, owner_id, rev)
  select id, workspace_id, path, 'folder', 'private', false, owner_id, 0 from plugin_folder;

-- Chats/ and its plugins' folders, which the moves left empty, deepest first.
create temporary table plugin_emptied (id text, workspace_id text, path text) on commit drop;
do $$
declare
  found int;
begin
  loop
    with emptied as (
      update fs_node n set deleted_at = now()
      where n.deleted_at is null and n.kind = 'folder' and n.path ~ '^home/[^/]+/Chats(/[^/]+)?$'
        and not exists (
          select 1 from fs_node c
          where c.workspace_id = n.workspace_id and c.deleted_at is null and left(c.path, length(n.path) + 1) = n.path || '/')
      returning n.id, n.workspace_id, n.path
    )
    insert into plugin_emptied select * from emptied;
    get diagnostics found = row_count;
    exit when found = 0;
  end loop;
end
$$;

with logged as (
  insert into fs_change(workspace_id, node_id, op, path, from_path, kind, content_hash, access, actor_id)
  select n.workspace_id, n.id, change.op, n.path, change.from_path, n.kind, n.content_hash, n.access, null
  from (
    select id, 'create' as op, null as from_path, 0 as phase, path as sort from plugin_folder
    union all
    select id, 'move', from_path, 1, path from plugin_move
    union all
    select id, 'delete', null, 2, path from plugin_emptied
  ) change
  join fs_node n on n.id = change.id
  order by n.workspace_id, change.phase, case when change.phase = 2 then '' else change.sort end, change.sort desc
  returning node_id, seq
)
update fs_node n set rev = l.seq from logged l where n.id = l.node_id;

alter table fs_node force row level security;
alter table fs_change force row level security;
