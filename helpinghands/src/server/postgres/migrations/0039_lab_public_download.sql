-- RUSH Lab is downloaded by anyone (routes/lab.js): its download page and install command are
-- public, and a member signs in in the app. Its bundles are still written only by the upload path.
drop policy lab_bundle_read on lab_bundle;
create policy lab_bundle_read on lab_bundle for select using (true);
drop policy lab_bundle_chunk_read on lab_bundle_chunk;
create policy lab_bundle_chunk_read on lab_bundle_chunk for select using (true);
