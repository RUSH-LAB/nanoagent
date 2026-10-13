-- A workspace's own tags for the plugins it added (workspace-apps.js): the
-- Plugins page files them under these. A plugin names no tag of its own; an
-- owner tags it for the workspace, and every member sees the same tags.
alter table workspace_plugin add column tags text[] not null default '{}';
