-- The folders Mochi names in a member's home are lowercase words joined by _
-- (docs/plans/filesystem-layout.md):
--
--   home/<user>/Plugins/…                              home/<user>/plugins/…
--   home/<user>/plugins/<plugin>/chats/2026-10-19 Find the paper/   …/chats/2026_10_19_find_the_paper/
--
-- and what runs left before plugins had folders of their own,
-- home/<user>/From earlier runs/, goes to the trash, where its member may
-- restore any of it. Nothing moves if a target is taken. Every move and
-- delete is logged, by no one, so every client following the change log does
-- the same.
alter table fs_node no force row level security;
alter table fs_change no force row level security;

-- Each chat folder's new name: lowercase words joined by _, numbered when two would share one.
create temporary table chat_rename on commit drop as
  select workspace_id, folder, parent || '/' || name || case when number > 1 then '_' || number else '' end as renamed
  from (
    select workspace_id, folder, parent, name,
      row_number() over (partition by workspace_id, parent, name order by folder) as number
    from (
      select n.workspace_id, n.path as folder,
        regexp_replace(n.path, '^home/([^/]+)/Plugins/', 'home/\1/plugins/') as moved,
        regexp_replace(regexp_replace(n.path, '^home/([^/]+)/Plugins/', 'home/\1/plugins/'), '/[^/]+$', '') as parent,
        coalesce(nullif(btrim(regexp_replace(lower(substring(n.path from '[^/]+$')), '[^a-z0-9]+', '_', 'g'), '_'), ''), 'chat') as name
      from fs_node n
      where n.deleted_at is null and n.kind = 'folder' and n.path ~ '^home/[^/]+/Plugins/[^/]+/chats/[^/]+$'
    ) chats
  ) numbered;

create temporary table lower_move on commit drop as
  select n.id, n.workspace_id, n.path as from_path,
    coalesce(
      (select r.renamed || substring(n.path from length(r.folder) + 1) from chat_rename r
        where r.workspace_id = n.workspace_id and (n.path = r.folder or left(n.path, length(r.folder) + 1) = r.folder || '/')),
      regexp_replace(n.path, '^home/([^/]+)/Plugins', 'home/\1/plugins')
    ) as path
  from fs_node n
  where n.deleted_at is null and n.path ~ '^home/[^/]+/Plugins(/|$)';

create temporary table earlier_trash on commit drop as
  select n.id, n.workspace_id, n.path from fs_node n
  where n.deleted_at is null and n.path ~ '^home/[^/]+/From earlier runs(/|$)';

do $$
declare
  taken text;
begin
  select string_agg(n.workspace_id || ':' || n.path, ', ' order by n.workspace_id, n.path) into taken
  from lower_move m
  join fs_node n on n.workspace_id = m.workspace_id and n.path = m.path and n.deleted_at is null
  where n.id not in (select id from lower_move);
  if taken is not null then
    raise exception 'Cannot rename the plugin folders: these paths are taken: %', taken;
  end if;
end
$$;

update fs_node n set path = m.path, updated_at = now() from lower_move m where n.id = m.id;
update fs_node n set deleted_at = now() from earlier_trash t where n.id = t.id;

with logged as (
  insert into fs_change(workspace_id, node_id, op, path, from_path, kind, content_hash, access, actor_id)
  select n.workspace_id, n.id, change.op, n.path, change.from_path, n.kind, n.content_hash, n.access, null
  from (
    select id, 'move' as op, from_path, 0 as phase, path as sort from lower_move
    union all
    select id, 'delete', null, 1, path from earlier_trash
  ) change
  join fs_node n on n.id = change.id
  order by n.workspace_id, change.phase, case when change.phase = 1 then '' else change.sort end, change.sort desc
  returning node_id, seq
)
update fs_node n set rev = l.seq from logged l where n.id = l.node_id;

alter table fs_node force row level security;
alter table fs_change force row level security;
