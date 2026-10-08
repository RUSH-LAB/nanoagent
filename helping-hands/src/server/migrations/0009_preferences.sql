create table if not exists user_preferences (
  "userId" text not null primary key references "user" ("id") on delete cascade,
  "value" text not null default '{}',
  "updatedAt" text not null
);

create table if not exists workspace_settings (
  "organizationId" text not null primary key references "organization" ("id") on delete cascade,
  "value" text not null default '{}',
  "updatedAt" text not null
);

create table if not exists workspace_member_preferences (
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "userId" text not null references "user" ("id") on delete cascade,
  "value" text not null default '{}',
  "updatedAt" text not null,
  primary key ("organizationId", "userId")
);
