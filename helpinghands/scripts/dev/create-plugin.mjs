#!/usr/bin/env node
/**
 * Scaffold a plugin: npm run new:plugin -- <name> [--title "Some Title"]
 *
 * Copies plugins/_template into plugins/<name>, substituting the three tokens
 * the template is written against. The template is skipped by the loaders
 * because its name starts with `_`, so it can stay a working plugin — which is
 * the point: it is checked by tests/unit/plugins/loader/template.test.mjs, and
 * a contract the template no longer satisfies fails the suite.
 *
 * The rendering is exported so that test can scaffold into a temp directory
 * without going near plugins/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(HERE, '..', '..', 'plugins', '_template');
const PLUGINS_DIR = path.join(HERE, '..', '..', 'plugins');

/** Directory names are kebab-case, which is also the plugin's name and route. */
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** `reading-list` → `readingList`, for identifiers. */
export function toCamel(name) {
  return name.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/** `reading-list` → `Reading List`, for the title a human reads. */
export function toTitle(name) {
  return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...walk(path.join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found;
}

/**
 * Render the template into `dest`, returning the files written.
 *
 * Refuses to write over an existing directory: scaffolding is for a plugin that
 * does not exist yet, and the alternative is silently overwriting real work.
 */
export function renderPlugin({ name, title = toTitle(name), dest, templateDir = TEMPLATE_DIR }) {
  if (!NAME_RE.test(name)) {
    throw new Error(`"${name}" is not a valid plugin name: use kebab-case, e.g. reading-list`);
  }
  if (fs.existsSync(dest)) {
    throw new Error(`${dest} already exists`);
  }

  const tokens = { __NAME__: name, __CAMEL__: toCamel(name), __TITLE__: title };
  const written = [];
  for (const rel of walk(templateDir)) {
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let body = fs.readFileSync(path.join(templateDir, rel), 'utf8');
    for (const [token, value] of Object.entries(tokens)) {
      body = body.split(token).join(value);
    }
    fs.writeFileSync(target, body);
    written.push(rel);
  }
  return written;
}

function main(argv) {
  const args = argv.slice(2);
  let name;
  let title;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--title') { title = args[++i]; continue; }
    if (!name) name = args[i];
  }

  if (!name) {
    console.error('usage: npm run new:plugin -- <name> [--title "Some Title"]');
    process.exit(1);
  }

  const dest = path.join(PLUGINS_DIR, name);
  let written;
  try {
    written = renderPlugin({ name, title, dest });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Created plugins/${name}/`);
  for (const rel of written) console.log(`  ${rel}`);
  console.log('\nNothing else needs editing: the site discovers it. Next:');
  console.log(`  1. Delete the halves this tool does not have (see plugins/${name}/README.md)`);
  console.log('  2. Write it, with tests under tests/unit/plugins/' + name + '/');
  console.log('  3. npm test && npm run build');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv);
}
