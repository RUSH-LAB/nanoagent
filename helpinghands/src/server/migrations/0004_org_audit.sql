-- A record of who changed the membership of an organization.
--
-- Membership is the one thing in the product that one person can change on
-- another's behalf: an admin can promote, demote, and remove. A change like
-- that with nobody named against it is the kind of thing an organization
-- argues about later, so every one of them is written down here, by the code
-- path that performs it rather than by each caller remembering to.
--
-- The ids reference the account tables and set null on delete, because an
-- audit row has to outlive its subject: deleting an account must not delete
-- the record of what was done to it, and must not be blocked by that record
-- either. The labels are therefore denormalized on purpose. They are what the
-- person was called at the time, which is also the more honest thing to show
-- for a change made two renames ago.

create table if not exists org_audit (
  "id"             text not null primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  -- 'member.add' | 'member.remove' | 'member.role'
  "action"         text not null,
  "actorId"        text references "user" ("id") on delete set null,
  "actorLabel"     text not null,
  "targetId"       text references "user" ("id") on delete set null,
  "targetLabel"    text not null,
  -- The shape of the change, as JSON: {"from":"member","to":"admin"} for a
  -- role change, and absent for the others, whose action says it all.
  "detail"         text,
  "at"             text not null
);

-- The only read there is: one organization, newest first.
create index if not exists "org_audit_org_at_idx" on org_audit ("organizationId", "at" desc);
