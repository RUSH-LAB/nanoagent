-- The one table every per-workspace feature keeps its data in.
--
-- Thirteen features (bookmarks, tasks, notes, flashcards, goals, glossary,
-- reading lists, whiteboards, schedule, streaks, targets, snapshots, analytics)
-- were written before organizations existed and kept their data in a JSON file
-- each, under var/data/. Those files have no owner column and no organization
-- column, because when they were written there was one of each. GET
-- /api/bookmarks returned every bookmark on the machine, to anybody.
--
-- The obvious repair is thirteen tables. This is one, because the thing being
-- fixed is not the shape of any one feature, it is that thirteen features each
-- decide their own scoping and one of them will get it wrong. With a single
-- table there is a single place where the organization and the owner are
-- applied, ./store, and a query that forgets them cannot be written through it.
-- Per-feature tables come later where a feature earns one, and content gets its
-- own from the start (it needs versions and full-text, which this cannot give).
--
-- The columns:
--
--   organizationId  the workspace. Always present. Cascades, so deleting a
--                   workspace takes everything anybody stored in it.
--   ownerId         the person, when the item is theirs, and NULL when it
--                   belongs to the workspace. A glossary is the workspace's; a
--                   bookmark is yours. Cascades too: deleting an account takes
--                   that account's private items and leaves the shared ones,
--                   which is the same rule org_audit follows for its subjects.
--   domain          which feature. 'bookmarks', 'tasks', and so on.
--   key             the item's identity within (workspace, owner, domain). The
--                   feature chooses it: a bookmark uses its path, a task its id.
--   value           the item, as JSON.
--
-- Uniqueness is an expression index rather than a primary key because ownerId
-- is nullable and SQLite (like Postgres) treats NULLs in a unique index as
-- distinct from each other, which would have let a workspace-owned item be
-- inserted twice. COALESCE folds the two cases into one comparable value. Both
-- dialects index expressions, so this survives the move to Postgres.

create table if not exists store_item (
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "ownerId"        text          references "user" ("id")         on delete cascade,
  "domain"         text not null,
  "key"            text not null,
  "value"          text not null,
  "createdAt"      text not null,
  "updatedAt"      text not null
);

-- One item per (workspace, owner, domain, key). See the note above on COALESCE.
create unique index if not exists "store_item_identity_uidx"
  on store_item ("organizationId", "domain", coalesce("ownerId", ''), "key");

-- The read every list does: one workspace, one owner, one domain. The columns
-- are in the order the identity index has them so one index could in principle
-- serve both, but a list must also match NULL owners, which the expression
-- index cannot be probed for, so it gets its own.
create index if not exists "store_item_scope_idx"
  on store_item ("organizationId", "domain", coalesce("ownerId", ''));

-- Deleting an account walks this. Without it that is a full scan of everything
-- everybody has ever stored.
create index if not exists "store_item_owner_idx" on store_item ("ownerId");
