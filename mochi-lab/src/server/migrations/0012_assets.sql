create table if not exists asset (
  "id" text not null primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "objectKey" text not null,
  "contentType" text not null,
  "byteSize" integer not null check ("byteSize" >= 0),
  "sha256" text not null,
  "createdBy" text references "user" ("id") on delete set null,
  "createdAt" text not null,
  unique ("organizationId", "objectKey")
);
create index if not exists asset_organization_idx on asset ("organizationId");
