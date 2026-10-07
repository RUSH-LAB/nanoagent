-- The workspace file system (docs/plans/workspace-filesystem.md): one tree of
-- files and folders per workspace, their contents by SHA-256, and the
-- append-only log of every change. Additive: the document and asset tables
-- remain, and CONTENT_STORE selects which store serves the application.

create table fs_content (
  workspace_id text not null references workspace(id) on delete cascade,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  body bytea not null,
  size bigint not null check (size = octet_length(body)),
  created_at timestamptz not null default now(),
  primary key (workspace_id, hash)
);

create table fs_node (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  path text not null check (path <> '' and path !~ '(^/|/$|\\\\|(^|/)\.\.?(/|$)|//)'),
  kind text not null check (kind in ('file', 'folder')),
  content_hash text,
  size bigint not null default 0 check (size >= 0),
  content_type text,
  -- Effective access: members of the workspace, only its owner_id, or anyone.
  -- Stored on every node, so a policy never walks a node's ancestors.
  access text not null default 'workspace' check (access in ('workspace', 'private', 'public')),
  -- Whether access was set on this node rather than inherited from its folder.
  access_explicit boolean not null default false,
  owner_id text references app_user(id) on delete set null,
  -- Derived from the content on write, such as a Markdown document's title.
  meta jsonb not null default '{}'::jsonb,
  -- The seq of the last change to this node in fs_change.
  rev bigint not null,
  created_by text references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((kind = 'file') = (content_hash is not null)),
  foreign key (workspace_id, content_hash) references fs_content(workspace_id, hash)
);
create unique index fs_node_live_path_uidx on fs_node(workspace_id, path) where deleted_at is null;
create index fs_node_workspace_idx on fs_node(workspace_id) where deleted_at is null;
create index fs_node_content_idx on fs_node(workspace_id, content_hash);

create table fs_change (
  seq bigserial primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  node_id text not null,
  op text not null check (op in ('create', 'write', 'move', 'delete', 'restore', 'access')),
  path text not null,
  from_path text,
  kind text not null check (kind in ('file', 'folder')),
  content_hash text,
  access text,
  actor_id text references app_user(id) on delete set null,
  at timestamptz not null default now()
);
create index fs_change_workspace_seq_idx on fs_change(workspace_id, seq);
create index fs_change_node_idx on fs_change(node_id, seq);
create index fs_change_content_idx on fs_change(workspace_id, content_hash);

alter table fs_content enable row level security;
alter table fs_node enable row level security;
alter table fs_change enable row level security;

-- A node is visible to the members of its workspace unless it is private to
-- someone else, and to everyone, signed in or not, when it is public.
create policy fs_node_read on fs_node for select using (
  workspace_id = request_workspace_id() and (
    access = 'public'
    or (is_workspace_member(workspace_id) and (access <> 'private' or owner_id = request_user_id()))
  )
);
create policy fs_node_insert on fs_node for insert with check (
  workspace_id = request_workspace_id()
  and request_workspace_role(workspace_id) in ('owner', 'editor')
  and created_by = request_user_id()
  and (access <> 'private' or owner_id = request_user_id())
);
create policy fs_node_update on fs_node for update using (
  workspace_id = request_workspace_id()
  and request_workspace_role(workspace_id) in ('owner', 'editor')
  and (access <> 'private' or owner_id = request_user_id())
) with check (
  workspace_id = request_workspace_id()
  and request_workspace_role(workspace_id) in ('owner', 'editor')
  and (access <> 'private' or owner_id = request_user_id())
);
create policy fs_node_delete on fs_node for delete using (
  workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner'
);

-- Members read content by its hash. A private file's hash reaches only those
-- who may see its node or change, because those tables hide it, and the hash
-- of bytes nobody else has cannot be guessed. Anyone else reads only content a
-- public node names; that subquery is filtered by fs_node's own policy.
create policy fs_content_read on fs_content for select using (
  workspace_id = request_workspace_id() and (
    is_workspace_member(workspace_id)
    or exists (select 1 from fs_node n where n.workspace_id = fs_content.workspace_id and n.content_hash = fs_content.hash)
  )
);
create policy fs_content_insert on fs_content for insert with check (
  workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor')
);
create policy fs_content_delete on fs_content for delete using (
  workspace_id = request_workspace_id() and request_workspace_role(workspace_id) = 'owner'
);

-- The log is for members, and only for nodes they may see. It is never
-- rewritten: there is no update policy, and rows leave only with their workspace.
create policy fs_change_read on fs_change for select using (
  workspace_id = request_workspace_id()
  and is_workspace_member(workspace_id)
  and exists (select 1 from fs_node n where n.id = fs_change.node_id)
);
create policy fs_change_insert on fs_change for insert with check (
  workspace_id = request_workspace_id()
  and request_workspace_role(workspace_id) in ('owner', 'editor')
  and actor_id = request_user_id()
);

alter table fs_content force row level security;
alter table fs_node force row level security;
alter table fs_change force row level security;
