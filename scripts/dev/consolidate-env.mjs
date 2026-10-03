#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {parseEnv} from '../db/postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const destination = path.join(root, '.env');
const legacyFiles = [
  '.env.local',
  '.env.openai.local',
  '.env.openrouter.local',
  '.env.postgres.local',
  '.env.production.local',
  '.env.root-production.local',
].map(name => path.join(root, name));

const values = {};
for (const file of legacyFiles) {
  if (fs.existsSync(file)) Object.assign(values, parseEnv(fs.readFileSync(file, 'utf8')));
}
if (fs.existsSync(destination)) Object.assign(values, parseEnv(fs.readFileSync(destination, 'utf8')));

if (Object.keys(values).length === 0 && process.argv.includes('--initialize')) {
  values.OPENROUTER_API_KEY = 'replace-me';
}
if (Object.keys(values).length === 0) {
  console.log('No environment values found; nothing to consolidate.');
  process.exit(0);
}

const temporary = `${destination}.${process.pid}.tmp`;
fs.writeFileSync(
  temporary,
  `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
  {mode: 0o600},
);
fs.renameSync(temporary, destination);
fs.chmodSync(destination, 0o600);

for (const file of legacyFiles) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

console.log(`Consolidated local configuration into ${path.basename(destination)}.`);
