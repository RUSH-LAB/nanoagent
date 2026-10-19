-- RUSH Lab installs on Windows too (routes/lab.js): beside the two Macs, x86-64 Windows, whose app
-- is its installer. A target's app is no longer always a dmg, so that kind of bundle is the app.
-- Only the upload path writes bundles, through row-level security, which has no policy to update
-- them but this migration's own.
select set_config('app.lab_upload', 'on', true);
alter table lab_bundle drop constraint lab_bundle_target_check;
alter table lab_bundle add constraint lab_bundle_target_check
  check (target in ('aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc'));
alter table lab_bundle drop constraint lab_bundle_kind_check;
create policy lab_bundle_rename on lab_bundle for update using (request_lab_upload()) with check (request_lab_upload());
update lab_bundle set kind = 'app' where kind = 'dmg';
drop policy lab_bundle_rename on lab_bundle;
alter table lab_bundle add constraint lab_bundle_kind_check check (kind in ('app', 'update'));
