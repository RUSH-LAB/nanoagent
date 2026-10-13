-- A member's own home (home/<user>/) is theirs to write, viewers included: their
-- plugin runs keep their files in home/<user>/agent/ (fs/agent-sync.js). The
-- first home a workspace gets makes home/ too, which any member may create but
-- only an editor or owner may change.
create or replace function fs_may_write(p_workspace_id text, p_path text) returns boolean
language sql stable as $$
  select request_workspace_role(p_workspace_id) in ('owner', 'editor')
      or (is_workspace_member(p_workspace_id) and (
        left(p_path, 5) = 'chat/'
        or p_path = 'home/' || request_user_id()
        or left(p_path, length(request_user_id()) + 6) = 'home/' || request_user_id() || '/'))
$$;

create or replace function fs_may_make_home(p_workspace_id text, p_path text, p_kind text) returns boolean
language sql stable as $$
  select p_path = 'home' and p_kind = 'folder' and is_workspace_member(p_workspace_id)
$$;

drop policy fs_node_insert on fs_node;
create policy fs_node_insert on fs_node for insert with check (
  workspace_id = request_workspace_id()
  and (fs_may_write(workspace_id, path) or (fs_may_make_home(workspace_id, path, kind) and access = 'workspace'))
  and created_by = request_user_id()
  and (access in ('workspace', 'public') or owner_id = request_user_id()
       or (access = 'shared' and fs_shared_with_me(share_root)))
);

drop policy fs_change_insert on fs_change;
create policy fs_change_insert on fs_change for insert with check (
  workspace_id = request_workspace_id()
  and (fs_may_write(workspace_id, path) or (fs_may_make_home(workspace_id, path, kind) and op = 'create'))
  and actor_id = request_user_id()
);
