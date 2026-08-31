#!/usr/bin/env node
/**
 * Read a workspace's content tree off disk and write it into the document
 * table, so that the same pages can be served per request instead of only at
 * build time.
 *
 * The files stay authoritative for now. This is an import, not a move: it can
 * be run again after editing the tree, and it can be undone by emptying the
 * table. Flipping which side is the source of truth is a later step, and a
 * deliberately separate one, because that is the step that cannot be reversed
 * by deleting rows.
 *
 * What it does not do is decide anything about a document that the file cannot
 * answer. Everything imported is visible to the workspace, because that is what
 * a file in a git-tracked tree already was; nothing becomes private by being
 * imported. The author is left null, because the filesystem does not record
 * one and inventing whoever ran the script would be worse than admitting it.
 *
 *   node scripts/import-content.mjs                  # report what it would do
 *   node scripts/import-content.mjs --write          # do it
 *   node scripts/import-content.mjs --write --org lab
 */
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const WRITE = argv.includes('--write');
const ONLY_ORG = flag('org');

const {db} = require(path.join(ROOT, 'src/server/db.js'));
const documents = require(path.join(ROOT, 'src/server/documents.js'));
const {contentDirFor} = require(path.join(ROOT, 'src/server/paths.js'));

/** The extensions the site treats as content. */
const CONTENT_EXTS = ['.md', '.mdx'];

/**
 * Every content file under `dir`, as paths relative to it.
 *
 * Dot directories are skipped, which is what walkDir on the server does, and
 * what keeps .git and .trash out of a workspace's page list.
 */
function walk(dir, base = dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, found);
    else if (CONTENT_EXTS.some(ext => entry.name.endsWith(ext))) {
      found.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return found;
}

function main() {
  const orgs = db
    .prepare('SELECT id, slug, name FROM organization ORDER BY createdAt, rowid')
    .all()
    .filter(o => !ONLY_ORG || o.slug === ONLY_ORG);

  if (orgs.length === 0) {
    throw new Error(ONLY_ORG ? `No workspace with the slug "${ONLY_ORG}".` : 'No workspaces exist yet.');
  }
  console.log(WRITE ? 'Writing.\n' : 'Dry run. Pass --write to apply.\n');

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const org of orgs) {
    const root = contentDirFor(org.slug);
    const files = walk(root);
    if (files.length === 0) {
      console.log(`${org.slug.padEnd(16)} no content tree at ${path.relative(ROOT, root)}`);
      continue;
    }
    // The import acts as the workspace rather than as a person, so a private
    // document belonging to somebody is invisible to it and cannot be
    // overwritten by a file of the same path. That is the right way round: the
    // tree does not know about private drafts and should not clobber one.
    const scope = {orgId: org.id, userId: null};
    let made = 0;
    let saved = 0;
    let same = 0;

    for (const relative of files) {
      let markdown;
      try {
        markdown = fs.readFileSync(path.join(root, relative), 'utf-8');
      } catch (err) {
        console.log(`  ${relative}: unreadable (${err.message})`);
        continue;
      }
      const existing = documents.get(scope, relative);
      if (!existing) {
        if (WRITE) documents.create(scope, {path: relative, markdown});
        made++;
      } else if (existing.markdown !== markdown) {
        // A save, so the version it replaces is kept: re-importing after
        // editing the tree leaves a history rather than silently overwriting.
        if (WRITE) documents.save(scope, relative, markdown);
        saved++;
      } else {
        same++;
      }
    }

    created += made;
    updated += saved;
    unchanged += same;
    const parts = [`${made} new`, `${saved} changed`, `${same} unchanged`];
    console.log(`${org.slug.padEnd(16)} ${String(files.length).padStart(4)} file(s): ${parts.join(', ')}`);
  }

  console.log(
    `\n${created} created, ${updated} updated, ${unchanged} already current`
    + `${WRITE ? '' : ' (nothing written)'}.`,
  );
}

try {
  main();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
