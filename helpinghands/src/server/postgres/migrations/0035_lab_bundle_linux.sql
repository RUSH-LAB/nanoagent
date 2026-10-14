-- Mochi Lab's one-line install runs on Linux too, Windows's WSL2 included: a
-- bundle for x86-64 Linux beside the two for macOS (routes/lab.js).
alter table lab_bundle drop constraint lab_bundle_target_check;
alter table lab_bundle add constraint lab_bundle_target_check
  check (target in ('aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu'));
