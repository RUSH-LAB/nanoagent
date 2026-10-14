-- What members submit to their workspace (routes/submissions.js): a plugin they
-- published to the marketplace, as the version and package it was then, from the
-- commit it was packed from, and the statement the workspace asked them to agree
-- to (its settings' submissions.statement) as it read when they agreed. A
-- submission is a record: nobody changes or removes it. An owner reads every
-- submission in the workspace; any other member reads their own.
create table workspace_submission (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null references app_user(id) on delete cascade,
  plugin_id text not null,
  version text not null,
  sha256 text not null,
  repository jsonb not null,
  statement text not null,
  created_at timestamptz not null default now()
);
create index workspace_submission_workspace_idx on workspace_submission(workspace_id, created_at);

alter table workspace_submission enable row level security;
create policy workspace_submission_read on workspace_submission for select
  using (workspace_id = request_workspace_id()
    and (user_id = request_user_id() or request_workspace_role(workspace_id) = 'owner'));
create policy workspace_submission_insert on workspace_submission for insert
  with check (workspace_id = request_workspace_id() and user_id = request_user_id()
    and is_workspace_member(workspace_id));
alter table workspace_submission force row level security;
