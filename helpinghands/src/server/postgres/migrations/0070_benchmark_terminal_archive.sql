-- A member may archive one of their Harness tab sessions on the plugin page's Dashboard, as they archive a chat (0025): it leaves the
-- sessions list for its Archived view, and comes back when they restore it.
alter table benchmark_run add column archived_at timestamptz;
