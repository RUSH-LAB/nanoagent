# Repository instructions

## Database

- There is one database: the `production` branch of the Neon project `curly-rice-08210507`. Railway and local `npm start` both use it, so local changes are real. Never create another branch or database to work on; CI's throwaway ones are the only exception.
- Local holds only the runtime role's `DATABASE_URL` (`npm run db:setup` reads it from Railway); `npm start` refuses a `DATABASE_MIGRATION_URL`, and refuses to start unless production has applied exactly this checkout's migrations (`assertSchemaCurrent`). Only Railway's deploy migrates, so a migration reaches the database only by release (docs/infra/neon-postgres-setup.md).
- `npm run test:postgres` creates and deletes rows, so it runs only on a loopback database (CI's); never point it at the shared one.
- The SQLite repositories (src/server/db.js and its siblings) serve only the unit tests, each on its own scratch file, and the one-time cutover from the old SQLite database (src/server/postgres/README.md). A schema change still needs a migration in both `src/server/migrations/` and `src/server/postgres/migrations/` while those tests run on SQLite.
