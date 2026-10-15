# Changelog

What each Mochi release changes, one sentence each.

## Unreleased

- Plugins are now installed by each user for themselves, and `npm start` runs on a local copy of production's database that `npm run db:pull` refreshes and `npm run db:push -- <slug>` sends one workspace of back.
