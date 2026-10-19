-- An upload keeps its latest version and each version a member stays on;
-- publishing removes the rest (postgres/market.js), so they hold none of the
-- uploader's 50 MB. Its uploader may remove any version but the latest, and
-- user_plugin_version_fkey refuses to remove one a member stays on.
create policy market_plugin_version_delete on market_plugin_version for delete using (
  exists (
    select 1 from market_plugin m
     where m.id = market_plugin_version.plugin_id and m.owner_id = request_user_id()
       and m.version <> market_plugin_version.version
  )
);
