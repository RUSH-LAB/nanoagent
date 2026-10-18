import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// The page's own alert, confirm and prompt: in RUSH Lab's window Tauri's dialog plugin replaces
// them (its confirm answers with a Promise, which `if (!confirm(...))` always takes as yes, and
// its calls are refused without a permission), and WKWebView has none. The site asks through
// clientPlatform.dialogs (src/platform/dialogs.js), which answers with a Promise.
const NATIVE = /(?<![\w.])(?<!function\s)(?:window\.|globalThis\.)?(?:alert|confirm|prompt)\(/;
const OWN = path.join('src', 'platform', 'dialogs.js');

function sources(folder) {
  return fs.readdirSync(folder, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(file);
    return /\.(js|jsx|ts|tsx|mjs)$/.test(entry.name) ? [file] : [];
  });
}

describe('dialogs', () => {
  it('are asked for through clientPlatform.dialogs, never the browser\'s own', () => {
    const offenders = ['src', 'plugins'].flatMap(folder => sources(path.join(root, folder)))
      .filter(file => path.relative(root, file) !== OWN)
      .flatMap(file => fs.readFileSync(file, 'utf8').split('\n')
        .map((line, index) => [line, index + 1])
        .filter(([line]) => NATIVE.test(line) && !/^\s*(\/\/|\*)/.test(line))
        .map(([, number]) => `${path.relative(root, file)}:${number}`));
    assert.deepEqual(offenders, []);
  });
});
