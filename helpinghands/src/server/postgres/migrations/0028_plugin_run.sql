-- A plugin run going on (src/server/app-runs.js): one at most per session,
-- from its message until its turn, answered or not, is in the session's chat.
-- It is kept here and on the member's computer, which holds the run across
-- its connections (src/runner/protocol.js), so a Mochi started since takes the
-- run up again where the computer still has it, and records it as interrupted
-- where it does not. `folder` is the run's folder on the computer and `sent`
-- the revisions of the files copied into it (src/server/fs/agent-sync.js), to
-- write what the run did back; `ran` is whether it got far enough to cost
-- anything. Private to the member, who reads their runs in every workspace.
create table plugin_run (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null references app_user(id) on delete cascade,
  session_id text not null unique references plugin_session(id) on delete cascade,
  plugin_id text not null,
  prompt text not null,
  install text not null,
  folder text,
  sent jsonb,
  ran boolean not null default false,
  started_at timestamptz not null default now()
);
create index plugin_run_user_idx on plugin_run(user_id);

alter table plugin_run enable row level security;
create policy plugin_run_owner on plugin_run for all
  using (user_id = request_user_id() and is_workspace_member(workspace_id))
  with check (workspace_id = request_workspace_id() and user_id = request_user_id() and is_workspace_member(workspace_id));
alter table plugin_run force row level security;
