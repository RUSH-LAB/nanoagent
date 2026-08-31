-- Content, as rows.
--
-- Every page in the product is a file under content/<slug>/, read off disk at
-- build time by Docusaurus and at request time by the editor. That worked while
-- there was one tree and one reader. It does not survive what the product is
-- becoming, for three reasons, and only the first is about performance:
--
--   A workspace created while the site runs has no pages until it restarts,
--   because Docusaurus fixes its plugin list at boot from the directories that
--   existed then.
--
--   Every workspace's content is compiled into one static bundle. There is no
--   point in that pipeline at which a reader's identity is known, so a private
--   page cannot be private: it ships to whoever asks for the site.
--
--   Build time grows with the number of workspaces, because each one's books
--   and posts are another plugin instance.
--
-- So content moves to the database and is rendered per request, against the
-- caller's session. This table is where it goes. The files stay for now and are
-- imported from; flipping which one is authoritative is a later step, and a
-- separate one, because it is the step that cannot be undone by deleting a
-- table.
--
-- ── The two body columns ────────────────────────────────────────────────────
--
-- `markdown` is the document as text: what renders, what search reads, what an
-- export writes out. `ydoc` is the same document as a Yjs update, and it is
-- empty until collaborative editing lands.
--
-- Both, from the start, because collaboration is not a feature that can be
-- added to a text column later. A CRDT's whole content is its history of
-- operations; a store that keeps only the latest text has thrown that away, and
-- two people editing at once can then only be resolved by one of them losing.
-- Adding the column later means migrating every document into a Y.Doc with no
-- history, which is the same as starting over. Adding it now costs a column
-- nothing writes yet.
--
-- When it does land, `ydoc` becomes authoritative and `markdown` becomes a
-- materialization of it, updated on each save. Everything that reads markdown
-- keeps working across that change, which is the point of having both.

create table if not exists document (
  "id"             text not null primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  -- Workspace-relative, the same string a request carries: books/math/0-intro.md
  -- and never content/mochi/books/math/0-intro.md. The organization is a column
  -- because it comes from the session; there is nowhere in a path to put one.
  "path"           text not null,
  "title"          text,
  "markdown"       text not null,
  -- The Yjs update. Null until collaborative editing writes one. See above.
  "ydoc"           blob,
  -- 'org'     every member of the workspace may read it
  -- 'private' only its author, until it is shared
  -- The default is 'org' because a lab's pages are the lab's; a draft nobody
  -- else should see is the exception and has to be asked for.
  "visibility"     text not null default 'org',
  -- SET NULL, not CASCADE: a page is the workspace's, not its author's, and
  -- deleting an account should not take the documentation with it. Same rule as
  -- channel.createdBy in 0003_chat.sql.
  "createdBy"      text references "user" ("id") on delete set null,
  "createdAt"      text not null,
  "updatedAt"      text not null,
  -- Soft delete, so a path can be reused and the rows that reference this one
  -- (its versions) still make sense. The unique index below is partial for
  -- exactly this reason.
  "deletedAt"      text
);

-- One live document per path per workspace. Partial, so deleting a page frees
-- its path for a new one while the old rows stay addressable.
create unique index if not exists "document_org_path_uidx"
  on document ("organizationId", "path") where "deletedAt" is null;

-- The read a file tree does: one workspace, everything live in it.
create index if not exists "document_org_idx"
  on document ("organizationId") where "deletedAt" is null;

-- Every save keeps the version it replaced.
--
-- The file version of this was var/data/snapshots.json, which held up to ten
-- named snapshots per file and only when somebody asked for one. This is every
-- save, which is what makes it a history rather than a set of bookmarks, and
-- what a collaborative editor needs underneath it anyway.
create table if not exists document_version (
  "id"         text not null primary key,
  "documentId" text not null references document ("id") on delete cascade,
  -- Per-document position, assigned on insert. Orders history, which a
  -- millisecond timestamp ties on when a save follows a save. Same reasoning,
  -- and the same column, as message.seq in 0003_chat.sql.
  "seq"        integer not null,
  "markdown"   text not null,
  -- Who saved it. SET NULL for the same reason as document.createdBy: the
  -- history outlives the account, and reads better attributed to nobody than
  -- deleted along with them.
  "authorId"   text references "user" ("id") on delete set null,
  "createdAt"  text not null
);

-- The read history does: one document, in order. Unique, so two versions of a
-- document can never share a position.
create unique index if not exists "document_version_doc_seq_uidx"
  on document_version ("documentId", "seq");
