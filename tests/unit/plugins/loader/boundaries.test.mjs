import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');

function sourceFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(?:c?js|mjs|jsx|tsx?)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('plugin dependency boundaries', () => {
  it('keeps every non-bibliography plugin independent of src', () => {
    const offenders = [];
    for (const file of sourceFiles(path.join(ROOT, 'plugins'))) {
      if (file.includes(`${path.sep}bibliography${path.sep}`)) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (/(?:from\s+|require\()["'](?:@site\/src|#markdown|#plugin-api|[^"']*\/src\/)/.test(source)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('lets src depend only on generic plugin host modules', () => {
    const offenders = [];
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const source = fs.readFileSync(file, 'utf8');
      const specs = [...source.matchAll(/(?:from\s+|require\()["']([^"']*plugins\/[^"']+)["']/g)]
        .map(match => match[1])
        .filter(spec => spec.startsWith('.') || spec.startsWith('@site/'));
      if (specs.some(spec => !spec.endsWith('plugins/loader') && !spec.endsWith('plugins/client-components'))) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    assert.deepEqual(offenders, []);
  });
});
