-- Application roles, moved out of var/data/users.json and into the database.
--
-- The JSON store was keyed by Better Auth user ids but had no link to the user
-- table, so nothing kept the two in step. Recreating the database gave root a
-- new id and left the old entry behind; after a few rounds of that, GET
-- /api/users listed three owners, two of them pointing at users that no longer
-- existed. A foreign key with ON DELETE CASCADE makes that state unreachable:
-- a role cannot outlive its user.
--
-- Kept as its own table rather than a column on `user`, because Better Auth
-- owns that table's schema and regenerates it from its plugin list.

create table if not exists user_role (
  "userId"  text not null primary key references "user" ("id") on delete cascade,
  "role"    text not null,
  "addedAt" text not null
);

create index if not exists "user_role_role_idx" on user_role ("role");
