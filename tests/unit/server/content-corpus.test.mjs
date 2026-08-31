import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {compileDocument} = require('../../../src/server/mdx.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const contentRoot = path.join(root, 'content');

function markdownFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(target));
    else if (/\.mdx?$/.test(entry.name)) files.push(target);
  }
  return files.sort();
}

describe('migrated workspace content corpus', () => {
  it('safely compiles every Markdown and MDX document used by the site', async () => {
    const files = markdownFiles(contentRoot);
    assert.equal(files.length, 153, 'update the compatibility baseline when the corpus intentionally changes');
    const failures = [];
    for (const file of files) {
      const relative = path.relative(contentRoot, file).replace(/\\/g, '/');
      try {
        await compileDocument({
          id: relative,
          path: relative,
          updatedAt: 'corpus-fixture',
          markdown: fs.readFileSync(file, 'utf8'),
        });
      } catch (error) {
        failures.push(`${relative}: ${error.message}`);
      }
    }
    assert.deepEqual(failures, []);
  });
});
