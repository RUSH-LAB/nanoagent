/**
 * The local SQL database.
 *
 * One SQLite file under var/data/, alongside the JSON stores it will eventually
 * replace. SQLite because it needs no server, no container, and no install: the
 * driver is a library and the database is a file, so `npm start` works on a
 * clean checkout.
 *
 * The obvious question is why not Postgres, given the multi-tenant plan wants
 * row-level security to enforce organization isolation in the database rather
 * than in a few hundred hand-written WHERE clauses. The answer is sequencing,
 * not preference. RLS is a Postgres feature and it is the right end state, and
 * this file is the seam where that swap happens.
 *
 * What carries the isolation until then is ./store, which is the only module
 * allowed to reach this one for tenant-scoped data. Every query it runs is
 * scoped by construction rather than by the caller remembering to say so, which
 * is the same guarantee RLS gives, made in the application instead of the
 * database. When Postgres arrives, that layer does not come out; it becomes the
 * inner of two locks.
 *
 * WAL mode lets the API server read while another connection writes, which
 * matters because the Docusaurus dev server and the API run side by side.
 * Foreign keys are off by default in SQLite and have to be asked for.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {DATA_DIR} = require('./paths');

const DB_FILE = process.env.DATABASE_FILE || path.join(DATA_DIR, 'mochi.db');

if (!fs.existsSync(path.dirname(DB_FILE))) {
  fs.mkdirSync(path.dirname(DB_FILE), {recursive: true});
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Apply any migration in migrations/ that this database has not seen, in
 * filename order, each in its own transaction.
 *
 * Run at require time rather than from a separate `npm run migrate` step, so a
 * clean checkout works on the first `npm start`. That is affordable because the
 * statements are all IF NOT EXISTS and the applied set is recorded, making the
 * common case a single indexed read of an eight-row table.
 */
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map(r => r.name));
  const pending = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql') && !applied.has(f)).sort()
    : [];

  const record = db.prepare('INSERT INTO _migrations (name, appliedAt) VALUES (?, ?)');
  for (const name of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8');
    // better-sqlite3 runs exec() and the INSERT in one transaction, so a
    // migration that throws partway leaves no record and no partial schema.
    db.transaction(() => {
      db.exec(sql);
      record.run(name, new Date().toISOString());
    })();
  }
  return pending;
}

const appliedMigrations = migrate();

module.exports = {db, DB_FILE, appliedMigrations, MIGRATIONS_DIR};
