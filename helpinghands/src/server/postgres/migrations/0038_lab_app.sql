-- RUSH Lab is the app now, not the one-line install (routes/lab.js): each
-- target's bundle is its dmg, and there is none for Linux. The install's
-- tarballs go, so none is served as an app; the release job uploads the dmgs.
-- Only the upload path may delete them, through row-level security.
select set_config('app.lab_upload', 'on', true);
delete from lab_bundle;
alter table lab_bundle drop constraint lab_bundle_target_check;
alter table lab_bundle add constraint lab_bundle_target_check
  check (target in ('aarch64-apple-darwin', 'x86_64-apple-darwin'));
