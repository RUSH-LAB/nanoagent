-- Chat: channels, membership, and messages, all scoped to an organization.
--
-- A direct message is not a separate concept here. It is a channel with
-- kind='dm', no name, and one or two members, so there is one message table, one send
-- path, and one permission check rather than two of each that must be kept in
-- agreement. The columns that only apply to one kind (name for named channels,
-- dmKey for direct messages) are nullable, and the partial unique indexes below
-- enforce each rule only where it applies.
--
-- Every foreign key cascades, so deleting an organization takes its channels,
-- their membership, and their messages with it, and deleting a user takes their
-- membership. Messages deliberately do NOT cascade from user: a conversation
-- with the replies missing is worse than one attributed to a departed account,
-- so message.userId restricts instead, and deleting a user who has spoken is
-- something the application must decide about rather than something a stray
-- DELETE can do by accident. channel.createdBy sets null for the same reason:
-- the channel outlives whoever opened it.

create table if not exists channel (
  "id"             text not null primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  -- 'public'  any member of the organization may read and join
  -- 'private' members only, by invitation
  -- 'dm'      one member for self-chat, otherwise two; no name
  "kind"           text not null,
  "name"           text,
  "topic"          text,
  -- The two participants of a dm, sorted and joined, so the pair has one
  -- canonical spelling and the unique index below can stop a second dm from
  -- being created when both people open one at the same moment.
  "dmKey"          text,
  -- SET NULL, not CASCADE: a channel is the organization's, not its author's,
  -- and deleting an account should not silently take #general and everyone
  -- else's messages in it.
  "createdBy"      text references "user" ("id") on delete set null,
  "createdAt"      text not null,
  "archivedAt"     text
);

-- One channel per name per organization, and one dm per pair per organization.
-- Both are partial: named channels have no dmKey and dms have no name.
create unique index if not exists "channel_org_name_uidx"
  on channel ("organizationId", "name") where "name" is not null;
create unique index if not exists "channel_org_dmkey_uidx"
  on channel ("organizationId", "dmKey") where "dmKey" is not null;
create index if not exists "channel_org_idx" on channel ("organizationId");

create table if not exists channel_member (
  "channelId"  text not null references channel ("id") on delete cascade,
  "userId"     text not null references "user" ("id") on delete cascade,
  "joinedAt"   text not null,
  -- The seq of the newest message this member has seen. A sequence rather than
  -- a timestamp because two events in the same millisecond compare equal, so a
  -- message posted in the same millisecond as a read was never counted unread.
  "lastReadSeq" integer not null default 0,
  primary key ("channelId", "userId")
);

create index if not exists "channel_member_user_idx" on channel_member ("userId");

create table if not exists message (
  "id"        text not null primary key,
  -- Per-channel position, assigned on insert. Orders history and measures
  -- unread counts, both of which a millisecond timestamp ties on.
  "seq"       integer not null,
  "channelId" text not null references channel ("id") on delete cascade,
  "userId"    text not null references "user" ("id"),
  "body"      text not null,
  "createdAt" text not null,
  "editedAt"  text,
  -- Soft delete: the row stays so replies around it still make sense, and the
  -- body is blanked when it is served.
  "deletedAt" text
);

-- The index every history read uses: one channel, in order. Unique, so two
-- messages in a channel can never share a position.
create unique index if not exists "message_channel_seq_uidx"
  on message ("channelId", "seq");
