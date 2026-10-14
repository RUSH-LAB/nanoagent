-- Each plugin's runs are given only their own folder, home/<user>/agent/<plugin>/
-- (fs/agent-sync.js). What runs left in home/<user>/agent/ before does not say
-- which plugin made it, so it moves, history and all, to the member's own
-- home/<user>/files/, which no run is given. Each node moved is logged as a move
-- by no one, so every client following the change log moves it too.
--
-- The tables' owner runs migrations, and forced row-level security would hide
-- every row from it; this migration's transaction lifts it for its moves only.
alter table fs_node no force row level security;
alter table fs_change no force row level security;

create temporary table agent_move on commit drop as
  select id, workspace_id, path as from_path, regexp_replace(path, '^(home/[^/]+)/agent', '\1/files') as path,
         kind, content_hash, access
  from fs_node
  where deleted_at is null and path ~ '^home/[^/]+/agent(/|$)';

update fs_node n set path = m.path, updated_at = now() from agent_move m where n.id = m.id;

with logged as (
  insert into fs_change(workspace_id, node_id, op, path, from_path, kind, content_hash, access, actor_id)
  select workspace_id, id, 'move', path, from_path, kind, content_hash, access, null
  from agent_move order by workspace_id, from_path
  returning node_id, seq
)
update fs_node n set rev = l.seq from logged l where n.id = l.node_id;

alter table fs_node force row level security;
alter table fs_change force row level security;
