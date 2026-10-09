-- The plugin marketplace (src/server/routes/market.js): NanoAgent plugin
-- packages people upload, for anyone signed in to download. Not workspace data:
-- one table across workspaces, readable by every signed-in user and changed
-- only by the user who uploaded the row. A package is a `nanoagent plugin pack`
-- archive that NanoAgent checked against every plugin rule before it was
-- stored; neither Mochi nor NanoAgent runs it.
create table market_plugin (
  -- The plugin's id: one namespace across every uploader.
  id text primary key,
  owner_id text not null references app_user(id) on delete cascade,
  version text not null,
  -- NanoAgent's catalog entry for the package: name, product page, tools, README.
  entry jsonb not null,
  package bytea not null,
  sha256 text not null,
  size integer not null check (size > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index market_plugin_owner_idx on market_plugin(owner_id);

alter table market_plugin enable row level security;
create policy market_plugin_read on market_plugin for select using (request_user_id() is not null);
create policy market_plugin_insert on market_plugin for insert with check (owner_id = request_user_id());
create policy market_plugin_update on market_plugin for update
  using (owner_id = request_user_id()) with check (owner_id = request_user_id());
create policy market_plugin_delete on market_plugin for delete using (owner_id = request_user_id());
alter table market_plugin force row level security;
