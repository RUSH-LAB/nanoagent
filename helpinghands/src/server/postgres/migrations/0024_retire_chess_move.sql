-- NanoAgent no longer offers its chess-move plugin. It leaves every workspace
-- that added it, and its sessions go with it, so an upload that later takes
-- the id starts with none. The calls they made stay in ai_usage, without
-- their session.
--
-- The tables' owner runs migrations, and forced row-level security would hide
-- every row from it; unforced, it binds everyone but the owner. This
-- migration's transaction lifts it for its two deletes only.
alter table workspace_plugin no force row level security;
alter table plugin_session no force row level security;
delete from workspace_plugin where plugin_id = 'chess-move' and source = 'nanoagent';
delete from plugin_session where plugin_id = 'chess-move';
alter table workspace_plugin force row level security;
alter table plugin_session force row level security;
