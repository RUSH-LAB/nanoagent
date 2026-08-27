import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeMetadataSources } = require('../../../../server/server-utils.js');

const SRC_PATH = fileURLToPath(new URL('../../../../server/server-utils.js', import.meta.url));
const PROTO_SET = "new Set(['__proto__', 'constructor', 'prototype'])";

describe('mergeMetadataSources proto-key Set hoist', () => {
  it('hoists the proto-key Set to a module-scope constant (none allocated per call)', () => {
    // Function.prototype.toString returns the exact source of the body, so it
    // reflects what runs per call without any brace-matching guesswork.
    const fnSource = mergeMetadataSources.toString();
    const fileSource = readFileSync(SRC_PATH, 'utf8');

    // The per-call Set allocation is gone from the function body (pre-fix the
    // inline `const FORBIDDEN = new Set(...)` lived here, so this fails pre-fix).
    assert.ok(
      !fnSource.includes('new Set('),
      'mergeMetadataSources must not allocate any Set inside its body',
    );

    // The proto-key Set now lives once at module scope under the distinct name.
    assert.ok(
      fileSource.includes(`const METADATA_FORBIDDEN_FIELDS = ${PROTO_SET}`),
      'METADATA_FORBIDDEN_FIELDS must be defined once at module scope',
    );
    assert.ok(
      !fnSource.includes(PROTO_SET),
      'the proto-key Set literal must be hoisted out of mergeMetadataSources',
    );

    // The function consumes the hoisted constant.
    assert.ok(
      fnSource.includes('METADATA_FORBIDDEN_FIELDS.has('),
      'mergeMetadataSources must consume the hoisted METADATA_FORBIDDEN_FIELDS',
    );
  });

  it('excludes prototype-polluting own fields from the merged output', () => {
    // JSON.parse yields real own __proto__/constructor/prototype data keys
    // (unlike object-literal syntax), exercising the guard on the merge path.
    const evil = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": "x", "prototype": "y", "title": "Safe", "year": 2020}',
    );
    let merged;
    assert.doesNotThrow(() => { merged = mergeMetadataSources({ crossref: evil }); });

    assert.equal(merged.title, 'Safe');
    assert.equal(merged.year, 2020);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(merged, key),
        `merged output must not carry an own ${key} field`,
      );
    }
    // A dropped __proto__ guard re-points merged's own prototype (a leak that
    // hasOwnProperty cannot see), so pin the prototype chain explicitly too.
    assert.equal(Object.getPrototypeOf(merged), Object.prototype);
    // The global prototype was not polluted.
    assert.equal(({}).polluted, undefined);
  });

  it('merges a normal field identically across two consecutive calls', () => {
    // A shared module-scope Set could be silently mutated or weakened between
    // calls; identical output on a second call proves it is not.
    const input = { crossref: { title: 'Same', doi: '10.1/x' }, dblp: { venue: 'NeurIPS' } };
    const expected = { title: 'Same', doi: '10.1/x', venue: 'NeurIPS' };

    const first = mergeMetadataSources(input);
    const second = mergeMetadataSources(input);
    assert.deepEqual(first, expected);
    assert.deepEqual(second, first);

    // Even with a polluting call interleaved, a later normal call is unaffected.
    mergeMetadataSources({ crossref: JSON.parse('{"__proto__": {"polluted": true}, "title": "Evil"}') });
    const third = mergeMetadataSources(input);
    assert.deepEqual(third, first);
    assert.equal(({}).polluted, undefined);
  });
});
