-- A member's channel membership is the workspace's own bookkeeping, so joining
-- works in a workspace that is out of storage (0016). Chat moved to .chat/ in
-- 0045, so the storage limit leaves out .chat/<channel>/members/<user>.json.
create or replace function enforce_workspace_file_storage() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  added bigint;
  used bigint;
  allowed bigint;
begin
  if new.kind <> 'file' or new.deleted_at is not null then return new; end if;
  if new.path ~ '^\.chat/[^/]+/members/[^/]+\.json$' then return new; end if;
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
