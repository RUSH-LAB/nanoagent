'use strict';
// Publish a package as a new version of the owner's marketplace upload with the real marketplace code (postgres/market.js
// `publish`), which prunes the versions no member stays on. Run from helpinghands/:
//   node publish_version.js <database> <owner user id> <package.tar.gz> <catalog entry json>
const fs = require('fs');
const path = require('path');
const {createPool} = require(path.join(process.cwd(), 'src/server/postgres/client'));
const {createPostgresMarket} = require(path.join(process.cwd(), 'src/server/postgres/market'));

(async () => {
  const [database, owner, packagePath, entryPath] = process.argv.slice(2);
  const pool = createPool({DATABASE_URL: `postgres://mochi_runtime@127.0.0.1:55432/${database}`});
  try {
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    await createPostgresMarket({pool}).publish(owner, entry, fs.readFileSync(packagePath), {});
  } finally {
    await pool.end();
  }
})().catch(error => { console.error(error); process.exit(1); });
