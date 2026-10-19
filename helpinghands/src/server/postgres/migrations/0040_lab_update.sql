-- RUSH Lab updates itself (routes/lab.js): beside each target's dmg, its update, the app as the
-- updater's archive (RUSH Lab.app.tar.gz) with the signature the release job made for it with
-- the app's update key. Each target keeps its newest bundle of each kind.
alter table lab_bundle add column kind text not null default 'dmg' check (kind in ('dmg', 'update'));
alter table lab_bundle alter column kind drop default;
alter table lab_bundle add column signature text;
alter table lab_bundle add constraint lab_bundle_signature_check check ((signature is not null) = (kind = 'update'));
alter table lab_bundle drop constraint lab_bundle_pkey;
alter table lab_bundle add primary key (target, kind);
