-- Platform operators are not workspace roles. Presence in this table grants
-- access to internal operational endpoints, but never membership in a
-- workspace and never implicit access to its rows.
create table if not exists platform_admin (
  "userId"  text not null primary key references "user" ("id") on delete cascade,
  "addedAt" text not null
);

-- Preserve existing server operators once, while severing their role from the
-- owner/editor/viewer vocabulary used by workspace memberships.
insert or ignore into platform_admin ("userId", "addedAt")
select "userId", "addedAt" from user_role where role = 'owner';
