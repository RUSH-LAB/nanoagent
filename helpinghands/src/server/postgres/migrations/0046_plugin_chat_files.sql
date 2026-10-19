-- A plugin session's chat is a folder in its member's home (fs/chats.js,
-- docs/plans/filesystem-layout.md):
--
--   home/<user>/Chats/<plugin>/<YYYY-MM-DD> <title>/chat.json             the turns, as the page shows them
--   home/<user>/Chats/<plugin>/<YYYY-MM-DD> <title>/turns/<n>/graph.json  a turn's provenance graph
--
-- and chat_file names its chat.json by node id. Each session's turns kept so
-- far are written there now, as created by no one and logged, so every client
-- following the change log sees them. plugin_session.chat is no longer read or
-- written, and stays until the owner drops it.
alter table plugin_session add column chat_file text;

alter table fs_content no force row level security;
alter table fs_node no force row level security;
alter table fs_change no force row level security;
alter table plugin_session no force row level security;

create temporary table chat_session on commit drop as
  select s.id, s.workspace_id, s.user_id, s.plugin_id,
    to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD') || ' ' || coalesce(nullif(btrim(left(btrim(
      regexp_replace(regexp_replace(regexp_replace(s.title, '[/\\]', '-', 'g'), '\s+', ' ', 'g'), '^[\s.]+', '')
    ), 80)), ''), 'Chat') as name
  from plugin_session s
  where jsonb_array_length(s.chat) > 0;

-- Two chats of one plugin started the same day with the same title are told apart by a number.
update chat_session c set name = c.name || ' ' || n.number
  from (
    select id, row_number() over (partition by workspace_id, user_id, plugin_id, name order by id) as number
    from chat_session
  ) n
  where c.id = n.id and n.number > 1;

-- Every file to write: chat.json and each turn's graph.
create temporary table chat_file_new on commit drop as
  select gen_random_uuid()::text as node_id, c.id as session_id, c.workspace_id, c.user_id,
    'home/' || c.user_id || '/Chats/' || c.plugin_id || '/' || c.name || '/chat.json' as path,
    convert_to(jsonb_pretty(jsonb_build_object(
      'session', c.id, 'plugin', c.plugin_id,
      'turns', (select jsonb_agg(turn - 'graph' order by ord) from jsonb_array_elements(s.chat) with ordinality t(turn, ord))
    )) || E'\n', 'UTF8') as body
  from chat_session c join plugin_session s on s.id = c.id
  union all
  select gen_random_uuid()::text, c.id, c.workspace_id, c.user_id,
    'home/' || c.user_id || '/Chats/' || c.plugin_id || '/' || c.name || '/turns/' || lpad(t.ord::text, 3, '0') || '/graph.json',
    convert_to(jsonb_pretty(t.turn -> 'graph') || E'\n', 'UTF8')
  from chat_session c join plugin_session s on s.id = c.id
  cross join lateral jsonb_array_elements(s.chat) with ordinality t(turn, ord)
  where jsonb_typeof(t.turn -> 'graph') = 'object';

do $$
declare
  taken text;
begin
  select string_agg(f.workspace_id || ':' || f.path, ', ') into taken
  from chat_file_new f
  join fs_node n on n.workspace_id = f.workspace_id and n.deleted_at is null
    and (n.path = f.path or n.path = regexp_replace(f.path, '/chat\.json$', ''));
  if taken is not null then
    raise exception 'Cannot write the plugin chats: these paths are taken: %', taken;
  end if;
end
$$;

insert into fs_content(workspace_id, hash, body, size)
  select distinct on (workspace_id, encode(sha256(body), 'hex')) workspace_id, encode(sha256(body), 'hex'), body, octet_length(body)
  from chat_file_new
  on conflict do nothing;

-- The folders the files need that do not exist yet: home itself the
-- workspace's, everything in a member's home private to them.
create temporary table chat_folder_new on commit drop as
  select gen_random_uuid()::text as id, a.workspace_id, a.path,
    case when a.path = 'home' then 'workspace' else 'private' end as access,
    a.path ~ '^home/[^/]+$' as access_explicit,
    case when a.path = 'home' then null else substring(a.path from '^home/([^/]+)') end as owner_id
  from (
    select distinct f.workspace_id, array_to_string((string_to_array(f.path, '/'))[1:depth], '/') as path
    from chat_file_new f, generate_series(1, array_length(string_to_array(f.path, '/'), 1) - 1) depth
  ) a
  where not exists (
    select 1 from fs_node n where n.workspace_id = a.workspace_id and n.path = a.path and n.deleted_at is null
  );

insert into fs_node(id, workspace_id, path, kind, access, access_explicit, owner_id, rev)
  select id, workspace_id, path, 'folder', access, access_explicit, owner_id, 0 from chat_folder_new;

insert into fs_node(id, workspace_id, path, kind, content_hash, size, content_type, access, owner_id, rev, created_by)
  select f.node_id, f.workspace_id, f.path, 'file', encode(sha256(f.body), 'hex'), octet_length(f.body), 'application/json',
    'private', f.user_id, 0, f.user_id
  from chat_file_new f;

with logged as (
  insert into fs_change(workspace_id, node_id, op, path, kind, content_hash, access, actor_id)
  select n.workspace_id, n.id, 'create', n.path, n.kind, n.content_hash, n.access, null
  from fs_node n
  where n.id in (select id from chat_folder_new union all select node_id from chat_file_new)
  order by n.workspace_id, n.path
  returning node_id, seq
)
update fs_node n set rev = l.seq from logged l where n.id = l.node_id;

update plugin_session s set chat_file = f.node_id
  from chat_file_new f where f.session_id = s.id and f.path ~ '/chat\.json$';

alter table fs_content force row level security;
alter table fs_node force row level security;
alter table fs_change force row level security;
alter table plugin_session force row level security;
