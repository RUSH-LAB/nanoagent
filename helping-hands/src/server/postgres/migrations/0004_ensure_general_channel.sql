-- Keep the default conversation invariant for workspaces created before
-- lifecycle provisioning began.

update channel
   set archived_at = null
 where kind = 'public' and name = 'general';

insert into channel(id, workspace_id, kind, name, topic, created_by, created_at, archived_at)
select
  gen_random_uuid()::text,
  w.id,
  'public',
  'general',
  'Everything, to start with',
  (select wm.user_id from workspace_member wm where wm.workspace_id = w.id order by wm.created_at limit 1),
  now(),
  null
from workspace w
where w.status = 'active'
  and exists (select 1 from workspace_member wm where wm.workspace_id = w.id)
  and not exists (
    select 1 from channel c
     where c.workspace_id = w.id and c.kind = 'public' and c.name = 'general'
  )
on conflict do nothing;

insert into channel_member(workspace_id, channel_id, user_id, joined_at, last_read_seq)
select c.workspace_id, c.id, wm.user_id, now(), 0
from channel c
join workspace_member wm on wm.workspace_id = c.workspace_id
where c.kind = 'public' and c.name = 'general' and c.archived_at is null
on conflict (channel_id, user_id) do nothing;
