-- A user's GitHub username and bio, copied from GitHub at every sign-in
-- (auth.js). A blog post names its authors by GitHub username, and the byline
-- is the account's GitHub name, avatar and bio, so workspaces no longer keep
-- their own author records.
alter table app_user add column github_login text;
alter table app_user add column github_bio text;
create unique index app_user_github_login_uidx on app_user (lower(github_login));

update workspace_settings
   set value = (value - 'authors') #- '{authoring,defaultAuthor}'
 where value ? 'authors' or coalesce(value->'authoring', '{}'::jsonb) ? 'defaultAuthor';
