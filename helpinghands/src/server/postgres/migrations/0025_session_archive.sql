-- A member may archive a plugin session: it leaves the plugin's session list
-- for its Archived view, keeping its conversation and calls, and comes back
-- when they restore it or chat in it again.
alter table plugin_session add column archived_at timestamptz;
