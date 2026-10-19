-- RUSH Lab's engine (routes/lab.js): what the app runs, lab.mjs, the relay and NanoAgent, one
-- archive for every target, kept apart from the app, so a release that changes only them needs no
-- new app. It is signed with the app's update key, and names the shell it runs in (the app's own
-- files, desktop/), which an app takes it only for. The site keeps its newest one.
alter table lab_bundle drop constraint lab_bundle_target_check;
alter table lab_bundle add constraint lab_bundle_target_check
  check (target in ('aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'any'));
alter table lab_bundle drop constraint lab_bundle_kind_check;
alter table lab_bundle add constraint lab_bundle_kind_check check (kind in ('app', 'update', 'engine'));
alter table lab_bundle add constraint lab_bundle_engine_check check ((kind = 'engine') = (target = 'any'));
alter table lab_bundle drop constraint lab_bundle_signature_check;
alter table lab_bundle add constraint lab_bundle_signature_check check ((signature is not null) = (kind in ('update', 'engine')));
alter table lab_bundle add column shell text;
alter table lab_bundle add constraint lab_bundle_shell_check check ((shell is not null) = (kind = 'engine'));
