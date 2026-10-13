# Repository instructions

## Database

- Local development and production both run on PostgreSQL in the Neon project `curly-rice-08210507`, on separate branches: `npm start` and `npm run test:postgres` use `development`, Railway uses `production`. Nothing local connects to `production`. `npm start` refuses to run without `DATABASE_URL` and `DATABASE_MIGRATION_URL` (scripts/dev/start-local.mjs), so never run the app on SQLite or a local database.
- `npm run db:sync` resets `development` to production's current data, discarding what changed in `development`. Data only goes production → development; schema changes go through migrations, which apply to `development` when the local server starts and to `production` when Railway deploys (docs/infra/neon-postgres-setup.md).
- The SQLite repositories (src/server/db.js and its siblings) serve only the unit tests, each on its own scratch file, and the one-time cutover from the old SQLite database (src/server/postgres/README.md). A schema change still needs a migration in both `src/server/migrations/` and `src/server/postgres/migrations/` while those tests run on SQLite.
