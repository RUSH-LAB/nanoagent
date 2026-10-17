-- A marketplace plugin keeps every version its author publishes, as an editor's
-- extensions do: publishing adds one, never replaces one, so a version names
-- one package for good, and its author bumps `version` to publish again. The
-- plugin's row names its latest. Each member's install (user_plugin) follows
-- the latest, `version` null, or stays on the version it names until they
-- update it. A version goes only with its plugin.
create table market_plugin_version (
  plugin_id text not null references market_plugin(id) on delete cascade,
  version text not null,
  -- NanoAgent's catalog entry for the package: name, product page, tools, README.
  entry jsonb not null,
  -- {owner, repo, ref, path, commit}, as in 0013.
  repository jsonb,
  package bytea not null,
  sha256 text not null,
  size integer not null check (size > 0),
  published_at timestamptz not null default now(),
  primary key (plugin_id, version)
);

alter table market_plugin_version enable row level security;
create policy market_plugin_version_read on market_plugin_version for select using (request_user_id() is not null);
create policy market_plugin_version_insert on market_plugin_version for insert with check (
  exists (select 1 from market_plugin m where m.id = plugin_id and m.owner_id = request_user_id())
);

-- Each upload's package so far is its first version. The tables' owner runs
-- migrations, and forced row-level security would hide every row from it.
alter table market_plugin no force row level security;
insert into market_plugin_version (plugin_id, version, entry, repository, package, sha256, size, published_at)
select id, version, entry, repository, package, sha256, size, updated_at from market_plugin;
alter table market_plugin drop column entry, drop column repository, drop column package,
  drop column sha256, drop column size;
alter table market_plugin add constraint market_plugin_latest_fkey foreign key (id, version)
  references market_plugin_version(plugin_id, version) deferrable initially deferred;
alter table market_plugin force row level security;
alter table market_plugin_version force row level security;

-- The version a member stays on; null follows the latest. Only an upload has versions.
alter table user_plugin add column version text;
alter table user_plugin add constraint user_plugin_version_check check (version is null or source = 'upload');
alter table user_plugin add constraint user_plugin_version_fkey foreign key (upload_id, version)
  references market_plugin_version(plugin_id, version);
