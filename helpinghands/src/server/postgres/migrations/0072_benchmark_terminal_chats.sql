-- A Terminal session's chats: each conversation of an agent CLI it held, by the CLI's own conversation id, which the worker reads from
-- the CLI's state when the session ends (finalize's `chats`); the Dashboard lists an agent's chats, not its sessions. A session resumed
-- for one chat names it (`resume_chat`, the claim's resume.chat), and a chat archived from the Dashboard is archived on the session that
-- last held it (`archived_chats`, by "<agent>:<id>"), so talking in it again brings it back.
alter table benchmark_attempt add column chats jsonb;
alter table benchmark_run add column resume_chat jsonb;
alter table benchmark_run add column archived_chats jsonb not null default '{}';
