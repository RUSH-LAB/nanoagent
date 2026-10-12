-- Better Auth core tables (user, session, account, verification) plus the
-- organization plugin's tables (organization, member, invitation).
--
-- Compiled from the INSTALLED better-auth version via getMigrations() in
-- better-auth/db/migration, not from the standalone @better-auth/cli, which is
-- deprecated and lags the runtime: its 1.4 output omitted account.issuer and
-- every sign-up failed with "table account has no column named issuer".
--
-- To regenerate after changing the plugin list in auth.js, compile against an
-- EMPTY database (otherwise getMigrations returns only the delta) and add the
-- difference as a new migration file rather than editing this one. See
-- tests/unit/server/db-schema.test.mjs, which fails if this file drifts from
-- what the installed version expects.
--
-- Every statement is IF NOT EXISTS, so applying this to an existing database is
-- a no-op; the migration runner in db.js also records that it ran.

create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "username" text unique, "displayUsername" text);

create table if not exists "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text);

create table if not exists "account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);

create table if not exists "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);

create table if not exists "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);

create index if not exists "session_userId_idx" on "session" ("userId");

create index if not exists "account_userId_idx" on "account" ("userId");

create index if not exists "verification_identifier_idx" on "verification" ("identifier");

create index if not exists "member_organizationId_idx" on "member" ("organizationId");

create index if not exists "member_userId_idx" on "member" ("userId");

create index if not exists "invitation_organizationId_idx" on "invitation" ("organizationId");

create index if not exists "invitation_email_idx" on "invitation" ("email");

create unique index if not exists "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");
