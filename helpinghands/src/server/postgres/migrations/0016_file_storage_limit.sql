-- The storage limit is checked where a file is written (fs_node), not where its
-- bytes are (fs_content), so a write is judged by its path. A member's channel
-- membership (fs/chat.js) is the workspace's own bookkeeping, so joining, or
-- marking a channel read, works in a workspace that is out of storage.
drop trigger fs_content_storage_limit on fs_content;

create or replace function enforce_workspace_storage() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  added bigint;
  used bigint;
  allowed bigint;
begin
  added := new.byte_size - case when tg_op = 'UPDATE' then old.byte_size else 0 end;
  if added <= 0 then return new; end if;
  select storage_bytes into allowed from public.workspace_effective_limits(new.workspace_id);
  used := public.workspace_storage_used(new.workspace_id);
  if used + added > allowed then
    raise exception 'storage-limit-reached'
      using errcode = 'P0001',
            detail = format('used=%s added=%s limit=%s', used, added, allowed),
            hint = 'This workspace has reached its storage limit.';
  end if;
  return new;
end $$;

-- A file's bytes are stored before its node, so `used` already counts them.
create or replace function enforce_workspace_file_storage() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  added bigint;
  used bigint;
  allowed bigint;
begin
  if new.kind <> 'file' or new.deleted_at is not null then return new; end if;
  if new.path ~ '^chat/[^/]+/members/[^/]+\.json$' then return new; end if;
  added := new.size - case when tg_op = 'UPDATE' and old.deleted_at is null then old.size else 0 end;
  if added <= 0 then return new; end if;
  select storage_bytes into allowed from public.workspace_effective_limits(new.workspace_id);
  used := public.workspace_storage_used(new.workspace_id);
  if used > allowed then
    raise exception 'storage-limit-reached'
      using errcode = 'P0001',
            detail = format('used=%s added=%s limit=%s', used, added, allowed),
            hint = 'This workspace has reached its storage limit.';
  end if;
  return new;
end $$;
create trigger fs_node_storage_limit before insert or update on fs_node
  for each row execute function enforce_workspace_file_storage();

revoke execute on function enforce_workspace_file_storage() from public;
