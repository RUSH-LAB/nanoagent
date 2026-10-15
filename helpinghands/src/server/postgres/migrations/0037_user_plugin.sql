-- A plugin is installed by each member for themselves, not added by an owner
-- for the whole workspace: it runs on the member's own computer, on their own
-- OpenRouter key, into their own folder, so whether to run it is theirs to
-- decide. An install holds in every workspace its member is in, with the tags
-- they file it under. An upload's installs go when it leaves the marketplace,
-- as its workspaces' did (0019).
create table user_plugin (
  user_id text not null references app_user(id) on delete cascade,
  plugin_id text not null,
  source text not null check (source in ('nanoagent', 'upload')),
  upload_id text generated always as (case when source = 'upload' then plugin_id end) stored
    references market_plugin(id) on delete cascade,
  tags text[] not null default '{}',
  installed_at timestamptz not null default now(),
  primary key (user_id, plugin_id)
);
create index user_plugin_upload_idx on user_plugin(upload_id);

alter table user_plugin enable row level security;
create policy user_plugin_own on user_plugin for all
  using (user_id = request_user_id())
  with check (user_id = request_user_id());

-- Whoever added a plugin to a workspace now has it installed, with that
-- workspace's tags (the first workspace's, for one added to several). The
-- tables' owner runs migrations, and forced row-level security would hide
-- every row from it, so user_plugin's is forced only after the copy.
alter table workspace_plugin no force row level security;
insert into user_plugin (user_id, plugin_id, source, tags, installed_at)
select distinct on (added_by, plugin_id) added_by, plugin_id, source, tags, added_at
  from workspace_plugin
 where added_by is not null
 order by added_by, plugin_id, added_at;

drop table workspace_plugin;
alter table user_plugin force row level security;
