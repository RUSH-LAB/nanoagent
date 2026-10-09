-- Better Auth's device-authorization plugin (auth.js): the codes the
-- command-line client signs in with. Compiled with getMigrations() like
-- 0001_auth.sql.

create table if not exists "deviceCode" ("id" text not null primary key, "deviceCode" text not null, "userCode" text not null, "userId" text, "expiresAt" date not null, "status" text not null, "lastPolledAt" date, "pollingInterval" integer, "clientId" text, "scope" text);

create unique index if not exists "deviceCode_deviceCode_uidx" on "deviceCode" ("deviceCode");

create unique index if not exists "deviceCode_userCode_uidx" on "deviceCode" ("userCode");
