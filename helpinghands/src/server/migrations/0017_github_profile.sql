-- A user's GitHub username and bio, copied from GitHub at every sign-in
-- (auth.js), as postgres/migrations/0017_github_profile.sql.

alter table "user" add column "githubLogin" text;

alter table "user" add column "githubBio" text;

create unique index if not exists "user_githubLogin_uidx" on "user" (lower("githubLogin"));
