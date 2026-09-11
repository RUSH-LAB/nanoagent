import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoot = path.join(root, 'src');

function sourceFiles(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.[jt]sx?$/.test(entry.name) ? [absolute] : [];
  });
}

describe('client platform boundary', () => {
  it('keeps replaceable operating-system integrations in the platform adapter', () => {
    const platformFile = path.join(sourceRoot, 'platform', 'client.js');
    const forbidden = [
      /\blocalStorage\b/,
      /\bnavigator\.clipboard\b/,
      /\bwindow\.location\.(?:assign|reload)\b/,
      /\bwindow\.(?:confirm|prompt)\b/,
    ];

    for (const file of sourceFiles(sourceRoot)) {
      if (file === platformFile) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.doesNotMatch(source, pattern, path.relative(root, file));
      }
    }
  });
});
