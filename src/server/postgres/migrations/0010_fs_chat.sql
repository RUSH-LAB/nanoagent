-- Chat as files (docs/plans/workspace-filesystem.md): channels live under
-- chat/, and every member of a workspace may chat, viewers included. Writing
-- anywhere else still needs an editor or owner.
create or replace function fs_may_write(p_workspace_id text, p_path text) returns boolean
language sql stable as $$
  select request_workspace_role(p_workspace_id) in ('owner', 'editor')
      or (left(p_path, 5) = 'chat/' and is_workspace_member(p_workspace_id))
$$;

drop policy fs_node_insert on fs_node;
drop policy fs_node_update on fs_node;
create policy fs_node_insert on fs_node for insert with check (
  workspace_id = request_workspace_id()
  and fs_may_write(workspace_id, path)
  and created_by = request_user_id()
  and (access in ('workspace', 'public') or owner_id = request_user_id()
       or (access = 'shared' and fs_shared_with_me(share_root)))
);
create policy fs_node_update on fs_node for update using (
  workspace_id = request_workspace_id()
  and fs_may_write(workspace_id, path)
  and (access in ('workspace', 'public') or owner_id = request_user_id()
       or (access = 'shared' and fs_shared_with_me(share_root)))
) with check (
  workspace_id = request_workspace_id()
  and fs_may_write(workspace_id, path)
  and (access in ('workspace', 'public') or owner_id = request_user_id()
       or (access = 'shared' and fs_shared_with_me(share_root)))
);

-- Any member may store bytes; they are reachable only through a node.
drop policy fs_content_insert on fs_content;
create policy fs_content_insert on fs_content for insert with check (
  workspace_id = request_workspace_id() and is_workspace_member(workspace_id)
);

drop policy fs_change_insert on fs_change;
create policy fs_change_insert on fs_change for insert with check (
  workspace_id = request_workspace_id()
  and fs_may_write(workspace_id, path)
  and actor_id = request_user_id()
);

-- Who a node is shared with may be changed by whoever may write the node; the
-- subquery sees only nodes the caller may see. These are write policies only:
-- reading fs_share consults no other table, because fs_node's read policy
-- reads fs_share, and a read policy here that read fs_node would recurse.
drop policy fs_share_write on fs_share;
create policy fs_share_insert on fs_share for insert with check (
  workspace_id = request_workspace_id()
  and exists (select 1 from fs_node n where n.id = fs_share.node_id and fs_may_write(n.workspace_id, n.path))
);
create policy fs_share_delete on fs_share for delete using (
  workspace_id = request_workspace_id()
  and exists (select 1 from fs_node n where n.id = fs_share.node_id and fs_may_write(n.workspace_id, n.path))
);
