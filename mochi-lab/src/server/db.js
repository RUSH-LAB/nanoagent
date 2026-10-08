/**
 * The local SQL database.
 *
 * One SQLite file under var/data/ for local development and isolated tests.
 * Production selects the PostgreSQL repositories whenever DATABASE_URL is set;
 * this file is deliberately not loaded on that path.
 *
 * Local isolation is carried by the same scoped repository boundary used by
 * PostgreSQL. Production additionally enforces it with row-level security.
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
  const alreadyApplied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?');
  for (const name of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8');
    // better-sqlite3 runs exec() and the INSERT in one transaction, so a
    // migration that throws partway leaves no record and no partial schema.
    db.transaction(() => {
      // Another server process may have applied it after `pending` was read.
      // Recheck while holding SQLite's write transaction before executing DDL.
      if (alreadyApplied.get(name)) return;
      db.exec(sql);
      record.run(name, new Date().toISOString());
    })();
  }
  return pending;
}

const appliedMigrations = migrate();

module.exports = {db, DB_FILE, appliedMigrations, MIGRATIONS_DIR};
