#!/usr/bin/env node
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);

/** Provision the explicitly configured production root account once. */
export async function main() {
  if (process.env.PROVISION_ROOT_USER !== 'true') return;
  if (!process.env.ROOT_EMAIL || !process.env.ROOT_PASSWORD) {
    throw new Error('ROOT_EMAIL and ROOT_PASSWORD are required when PROVISION_ROOT_USER=true');
  }

  // Import after validating the opt-in. NODE_ENV is set to development only
  // for this one-off process so Better Auth does not attempt to email the
  // intentionally local root address. The deployed web process remains in
  // production mode.
  const postgres = require('../../src/server/postgres/database');
  const {auth} = require('../../src/server/auth');
  const {provisionRoot} = require('../../src/server/postgres-dev-auth');
  try {
    await postgres.ready;
    const userId = await provisionRoot(auth, {
      email: process.env.ROOT_EMAIL.trim().toLowerCase(),
      password: process.env.ROOT_PASSWORD,
      name: process.env.ROOT_NAME || 'Root User',
    });
    console.log(`Provisioned verified platform root ${process.env.ROOT_EMAIL} (${userId}).`);
  } finally {
    await postgres.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(`Production root provisioning failed: ${error?.message || String(error)}`);
      process.exit(1);
    });
}
