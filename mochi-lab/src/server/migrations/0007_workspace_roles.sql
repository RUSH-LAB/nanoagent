-- Converge Better Auth's default organization roles on the product vocabulary.
-- The application has one role model after this migration:
--   owner  -> owner
--   admin  -> editor
--   member -> viewer

update member set role = 'editor' where role = 'admin';
update member set role = 'viewer' where role = 'member';
update invitation set role = 'editor' where role = 'admin';
update invitation set role = 'viewer' where role = 'member';
