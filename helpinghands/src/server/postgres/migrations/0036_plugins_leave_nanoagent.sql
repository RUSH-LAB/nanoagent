-- NanoAgent no longer ships plugins. arxiv-source is published on the
-- marketplace from zeyuyang8/arxiv-source, so each workspace that added
-- NanoAgent's arxiv-source now has that upload, and its sessions, keyed by
-- plugin_id, carry over. The migration stops if the upload is missing or
-- comes from anyone else. bibtex-check, meal-suggestion and nasdaq-drawdown
-- are retired: they leave every workspace with their sessions, as chess-move
-- did in 0024. The calls they made stay in ai_usage, without their session.
--
-- The tables' owner runs migrations, and forced row-level security would hide
-- every row from it; this migration's transaction lifts it for these
-- statements only.
alter table workspace_plugin no force row level security;
alter table plugin_session no force row level security;
alter table market_plugin no force row level security;

do $$
begin
  if exists (select 1 from workspace_plugin where plugin_id = 'arxiv-source' and source = 'nanoagent')
     and not exists (
       select 1 from market_plugin m join app_user u on u.id = m.owner_id
        where m.id = 'arxiv-source'
          and m.repository->>'owner' = 'zeyuyang8' and m.repository->>'repo' = 'arxiv-source'
          and lower(u.github_login) = 'zeyuyang8')
  then
    raise exception 'Publish arxiv-source from zeyuyang8/arxiv-source as zeyuyang8 before this migration';
  end if;
end $$;
update workspace_plugin set source = 'upload' where plugin_id = 'arxiv-source' and source = 'nanoagent';

with retired as (
  delete from workspace_plugin
   where plugin_id in ('bibtex-check', 'meal-suggestion', 'nasdaq-drawdown') and source = 'nanoagent'
  returning workspace_id, plugin_id
)
delete from plugin_session s using retired r
 where s.workspace_id = r.workspace_id and s.plugin_id = r.plugin_id;

alter table workspace_plugin force row level security;
alter table plugin_session force row level security;
alter table market_plugin force row level security;
