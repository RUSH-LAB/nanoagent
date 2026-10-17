#!/usr/bin/env node

/**
 * The seccomp profile RUSH Lab cloud's runner container starts with
 * (infra/aws/runner/seccomp.json): Docker's default profile, the moby/profiles
 * release DEFAULT_TAG, and one rule more, BUBBLEWRAP, which lets the container's
 * processes make the namespaces and mounts bubblewrap needs to confine each
 * plugin (NanoAgent's `sandbox: bwrap`, nanoagent/docs/plans/plugin-sandbox.md).
 * Docker's default allows those calls only to a container with CAP_SYS_ADMIN,
 * which the runner never has (it drops every capability), and pivot_root to none.
 *
 *   node scripts/aws/seccomp.mjs     writes infra/aws/runner/seccomp.json again
 *
 * It downloads the default profile and refuses one whose bytes are not the
 * pinned release's (DEFAULT_SHA256). The unit test checks the committed profile
 * is that default and exactly BUBBLEWRAP, without the network (DEFAULT_CANONICAL).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_TAG = 'seccomp/v0.2.4';
export const DEFAULT_URL = `https://raw.githubusercontent.com/moby/profiles/${DEFAULT_TAG}/seccomp/default.json`;
// The release's bytes, as downloaded.
export const DEFAULT_SHA256 = '785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334';
// The release's profile as canonical() writes it: what the committed profile is, less BUBBLEWRAP.
export const DEFAULT_CANONICAL = '4dc1298afa7676147c1320afa42d72691fc55379ae762b392b56853574a7a38a';

/** The one rule the runner adds: bubblewrap's namespaces and mounts, for every process in the container. */
export const BUBBLEWRAP = Object.freeze({
  names: ['clone', 'unshare', 'mount', 'umount2', 'pivot_root'],
  action: 'SCMP_ACT_ALLOW',
  comment: 'RUSH Lab cloud runner: the namespaces and mounts bubblewrap makes to confine each plugin (helpinghands/infra/aws/runner)',
});

export const PROFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../infra/aws/runner/seccomp.json');

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

/** A profile as one line of JSON in its own key order: what DEFAULT_CANONICAL hashes. */
export const canonical = profile => sha256(JSON.stringify(profile));

/** The runner's profile: `defaults` with BUBBLEWRAP as its last rule. */
export function withBubblewrap(defaults) {
  return {...defaults, syscalls: [...defaults.syscalls, {...BUBBLEWRAP, names: [...BUBBLEWRAP.names]}]};
}

async function main() {
  const response = await fetch(DEFAULT_URL);
  if (!response.ok) throw new Error(`${DEFAULT_URL} answered ${response.status}`);
  const text = await response.text();
  if (sha256(text) !== DEFAULT_SHA256) {
    throw new Error(`${DEFAULT_URL} is not the pinned release: sha256 ${sha256(text)}, expected ${DEFAULT_SHA256}`);
  }
  const defaults = JSON.parse(text);
  if (canonical(defaults) !== DEFAULT_CANONICAL) {
    throw new Error(`DEFAULT_CANONICAL is ${DEFAULT_CANONICAL}; the pinned release's is ${canonical(defaults)}`);
  }
  fs.writeFileSync(PROFILE, `${JSON.stringify(withBubblewrap(defaults), null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), PROFILE)}: ${DEFAULT_TAG} and ${BUBBLEWRAP.names.join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
