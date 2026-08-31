#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import yaml from 'js-yaml';

const root = path.resolve(import.meta.dirname, '../..');
const bibliographyPath = path.join(root, 'content', 'mochi', 'bibliography', 'references.yaml');
const isTestReference = (key, entry) => (
  /^__test_\d+_(?:ref|import)$/.test(key)
  || /^__wf_\d+_ref$/.test(key)
  || /^wftest-\d+_ref$/.test(key)
  || /^Test Paper __rem_\d+$/.test(String(entry?.title || '').trim())
);
const apply = process.argv.includes('--apply');

const source = fs.readFileSync(bibliographyPath, 'utf8');
const references = yaml.load(source) || {};
const doomed = Object.keys(references).filter(key => isTestReference(key, references[key]));

if (!doomed.length) {
  console.log('No integration-test bibliography records found.');
  process.exit(0);
}

console.log(`${apply ? 'Removing' : 'Would remove'} ${doomed.length} integration-test bibliography records.`);
console.log(`First: ${doomed[0]}`);
console.log(`Last:  ${doomed.at(-1)}`);

if (!apply) {
  console.log('Run again with --apply to create a backup and write the cleaned bibliography.');
  process.exit(0);
}

for (const key of doomed) delete references[key];

const backupDir = path.join(root, 'var', 'backups');
fs.mkdirSync(backupDir, {recursive: true});
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `references-before-test-cleanup-${stamp}.yaml`);
fs.copyFileSync(bibliographyPath, backupPath);

const temporaryPath = `${bibliographyPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryPath, yaml.dump(references, {lineWidth: -1, noRefs: true}), 'utf8');
fs.renameSync(temporaryPath, bibliographyPath);

console.log(`Removed ${doomed.length} records; ${Object.keys(references).length} papers remain.`);
console.log(`Backup: ${backupPath}`);
