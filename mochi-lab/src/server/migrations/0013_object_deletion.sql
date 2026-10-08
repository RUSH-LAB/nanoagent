-- Durable outbox for object-storage cleanup. Workspace rows and their asset
-- metadata can be deleted transactionally; remote object deletion cannot join
-- that transaction, so keys are queued first and retried until removal works.
create table if not exists object_deletion (
  "id"          text not null primary key,
  "workspaceId" text not null,
  "objectKey"   text not null unique,
  "requestedAt" text not null,
  "attempts"    integer not null default 0,
  "lastError"   text
);

create index if not exists "object_deletion_requested_idx"
  on object_deletion ("requestedAt");
