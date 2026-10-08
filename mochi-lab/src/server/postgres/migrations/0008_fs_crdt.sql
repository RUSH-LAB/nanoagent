-- Mergeable files (docs/plans/workspace-filesystem.md): the Yjs document behind
-- a Markdown file, so concurrent and offline edits merge instead of
-- conflicting. `state` is the whole document as one update; `rev` is the file
-- revision whose text it last matched. A file written some other way (a plain
-- save, the CLI) is folded into the document the next time it is opened.
create table fs_crdt (
  node_id text primary key references fs_node(id) on delete cascade,
  workspace_id text not null references workspace(id) on delete cascade,
  state bytea not null,
  rev bigint not null,
  updated_at timestamptz not null default now()
);

alter table fs_crdt enable row level security;
-- Members who may see the file may read its document, and editors may write
-- it; the subquery is filtered by fs_node's own policy.
create policy fs_crdt_read on fs_crdt for select using (
  workspace_id = request_workspace_id() and is_workspace_member(workspace_id)
  and exists (select 1 from fs_node n where n.id = fs_crdt.node_id)
);
create policy fs_crdt_write on fs_crdt for all using (
  workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor')
  and exists (select 1 from fs_node n where n.id = fs_crdt.node_id)
) with check (
  workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor')
  and exists (select 1 from fs_node n where n.id = fs_crdt.node_id)
);
alter table fs_crdt force row level security;
