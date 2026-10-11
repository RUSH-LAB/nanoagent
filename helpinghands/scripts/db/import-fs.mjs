#!/usr/bin/env node
/**
 * Copy documents, uploaded assets, app records, and chat into the workspace
 * file system (src/server/fs/import.js), verifying documents and assets by SHA-256.
 *
 *   npm run fs:import                    report what would be imported; writes nothing
 *   npm run fs:import -- --apply         import workspaces whose file system is empty
 *   npm run fs:import -- --apply --replace
 *                                        also re-import workspaces that already have one,
 *                                        replacing it with the legacy content
 *
 * The legacy tables are left exactly as they were. Uses the schema owner's
 * connection (DATABASE_MIGRATION_URL) and applies pending migrations first.
 */
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createPool, migrate} = require('../../src/server/postgres/client.js');
const {importLegacyContent} = require('../../src/server/fs/import.js');

const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!['--apply', '--replace'].includes(flag)) throw new Error(`Unknown option ${flag}; use --apply and --replace`);
}
if (!process.env.DATABASE_MIGRATION_URL) throw new Error('DATABASE_MIGRATION_URL is required');

const pool = createPool({...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}, {max: 1});
try {
  await migrate(pool);
  const result = await importLegacyContent(pool, {
    apply: flags.has('--apply'),
    replace: flags.has('--replace'),
    log: entry => console.log(entry.skipped
      ? `${entry.workspace}: skipped, ${entry.skipped}`
      : `${entry.workspace}: ${entry.documents} documents, ${entry.assets} assets, ${entry.records} app records, `
        + `${entry.messages} chat messages, ${entry.folders} folders, verified`),
  });
  console.log(result.applied ? 'Imported.' : 'Dry run: nothing was written. Add --apply to import.');
} finally {
  await pool.end();
}
