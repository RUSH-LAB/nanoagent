# Repository instructions

## Database

- Production's database is the `production` branch of the Neon project `curly-rice-08210507`. Local `npm start` runs on its own PostgreSQL 18 cluster in `var/postgres` (`npm run db:setup`), which it migrates itself; `.env` holds no database URL (docs/infra/neon-postgres-setup.md).
- Data moves only by command: `npm run db:pull` replaces the local database with production's, and `npm run db:push -- <slug>` replaces one workspace on production with the local one, after it checks production's copy is unchanged since the pull. A push changes production: run it only when the user asks.
- `npm run test:postgres` creates and deletes rows, so it runs only on a loopback database (CI's); never point it at production.
- The SQLite repositories (src/server/db.js and its siblings) serve only the unit tests, each on its own scratch file, and the one-time cutover from the old SQLite database (src/server/postgres/README.md). A schema change still needs a migration in both `src/server/migrations/` and `src/server/postgres/migrations/` while those tests run on SQLite.
