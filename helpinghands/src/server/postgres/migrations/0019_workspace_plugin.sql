-- The plugins a workspace added from the marketplace (routes/workspace-plugins.js):
-- the ones its members see and run on the Plugins page. A plugin is one of
-- NanoAgent's own, or an upload (market_plugin), which takes it out of every
-- workspace when it is removed. A workspace runs a plugin's latest version.
create table workspace_plugin (
  workspace_id text not null references workspace(id) on delete cascade,
  plugin_id text not null,
  source text not null check (source in ('nanoagent', 'upload')),
  upload_id text generated always as (case when source = 'upload' then plugin_id end) stored
    references market_plugin(id) on delete cascade,
  added_by text references app_user(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (workspace_id, plugin_id)
);
create index workspace_plugin_upload_idx on workspace_plugin(upload_id);

alter table workspace_plugin enable row level security;
create policy workspace_plugin_read on workspace_plugin for select
  using (workspace_id = request_workspace_id() and is_workspace_member(workspace_id));
create policy workspace_plugin_write on workspace_plugin for all
  using (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner')
  with check (workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner');
alter table workspace_plugin force row level security;
