alter table asset add column path text;
update asset set path = id where path is null;
alter table asset add constraint asset_workspace_path_unique unique (workspace_id, path);

create policy asset_update on asset for update using (
  workspace_id = request_workspace_id()
  and request_workspace_role(workspace_id) in ('owner', 'editor')
) with check (
  workspace_id = request_workspace_id()
  and request_workspace_role(workspace_id) in ('owner', 'editor')
  and created_by = request_user_id()
);
