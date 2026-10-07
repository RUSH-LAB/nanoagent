-- Sharing with specific people (docs/plans/workspace-filesystem.md): a node
-- whose access is `shared` is visible to its owner and to the members listed
-- for its share root, the node where the sharing was set. Descendants inherit
-- the share root as they inherit any access, so a policy reads one list.
alter table fs_node add column share_root text;
alter table fs_node drop constraint fs_node_access_check;
alter table fs_node add constraint fs_node_access_check
  check (access in ('workspace', 'private', 'shared', 'public'));
alter table fs_node add constraint fs_node_share_root_check check ((access = 'shared') = (share_root is not null));

create table fs_share (
  node_id text not null references fs_node(id) on delete cascade,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null references app_user(id) on delete cascade,
  primary key (node_id, user_id)
);
create index fs_share_user_idx on fs_share(workspace_id, user_id);

alter table fs_share enable row level security;
-- Members see who a node is shared with; the policy does not consult fs_node,
-- whose own policy consults this table.
create policy fs_share_read on fs_share for select using (
  workspace_id = request_workspace_id() and is_workspace_member(workspace_id)
);
create policy fs_share_write on fs_share for all using (
  workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor')
) with check (
  workspace_id = request_workspace_id() and request_workspace_role(workspace_id) in ('owner', 'editor')
);
alter table fs_share force row level security;

create or replace function fs_shared_with_me(p_share_root text) returns boolean
language sql stable as $$
  select exists (select 1 from fs_share s where s.node_id = p_share_root and s.user_id = request_user_id())
$$;

drop policy fs_node_read on fs_node;
drop policy fs_node_insert on fs_node;
drop policy fs_node_update on fs_node;
create policy fs_node_read on fs_node for select using (
  workspace_id = request_workspace_id() and (
    access = 'public'
    or (is_workspace_member(workspace_id) and (
      access = 'workspace'
      or owner_id = request_user_id()
      or (access = 'shared' and fs_shared_with_me(share_root))
    ))
  )
);
create policy fs_node_insert on fs_node for insert with check (
  workspace_id = request_workspace_id()
  and request_workspace_role(workspace_id) in ('owner', 'editor')
  and created_by = request_user_id()
  and (access in ('workspace', 'public') or owner_id = request_user_id()
       or (access = 'shared' and fs_shared_with_me(share_root)))
);
create policy fs_node_update on fs_node for update using (
  workspace_id = request_workspace_id()
  and request_workspace_role(workspace_id) in ('owner', 'editor')
  and (access in ('workspace', 'public') or owner_id = request_user_id()
       or (access = 'shared' and fs_shared_with_me(share_root)))
) with check (
  workspace_id = request_workspace_id()
  and request_workspace_role(workspace_id) in ('owner', 'editor')
  and (access in ('workspace', 'public') or owner_id = request_user_id()
       or (access = 'shared' and fs_shared_with_me(share_root)))
);
