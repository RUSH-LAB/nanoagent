-- A Terminal session's files, uploaded when it ends (finalize's `workspace`, nanoagent.uploaded.workspace_upload): `{sha256, bytes,
-- chunks}`, a tar.zst stored as the attempt's payloads in the order `chunks` names them, or `{error}`, why nothing was uploaded.
-- The trace export links it (GET /api/traces/workspaces/<attempt id>); null for an attempt that uploads none.
alter table benchmark_attempt add column workspace jsonb;
