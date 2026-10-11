-- Plugin sessions (src/server/postgres/sessions.js): one sitting with a
-- NanoAgent plugin's page, which its member can leave and resume. The page's
-- own state and the conversation with the plugin's agent are kept here; the
-- files it made stay in the member's agent folder. Private to the member.
create table plugin_session (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null references app_user(id) on delete cascade,
  plugin_id text not null,
  title text not null default '',
  -- Whatever the page saved to come back to, as JSON.
  state jsonb,
  -- The conversation so far: [{prompt, answer}], the latest turns only.
  chat jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plugin_session_owner_idx on plugin_session(workspace_id, user_id, plugin_id, updated_at desc);

alter table plugin_session enable row level security;
create policy plugin_session_owner on plugin_session for all
  using (workspace_id = request_workspace_id() and user_id = request_user_id() and is_workspace_member(workspace_id))
  with check (workspace_id = request_workspace_id() and user_id = request_user_id() and is_workspace_member(workspace_id));
alter table plugin_session force row level security;

-- Which plugin session a call belongs to, which task it ran, and how long it
-- took: from the run's start to its first streamed token, the time spent
-- streaming tokens, and the whole run. Null where the call reported none.
alter table ai_usage add column plugin_id text;
alter table ai_usage add column session_id text references plugin_session(id) on delete set null;
alter table ai_usage add column task text;
alter table ai_usage add column ttft_s double precision check (ttft_s >= 0);
alter table ai_usage add column generation_s double precision check (generation_s >= 0);
alter table ai_usage add column duration_s double precision check (duration_s >= 0);
create index ai_usage_session_idx on ai_usage(session_id, at) where session_id is not null;
