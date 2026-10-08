alter table asset add column "path" text;
update asset set "path" = "id" where "path" is null;
create unique index if not exists asset_organization_path_uidx
  on asset ("organizationId", "path");
