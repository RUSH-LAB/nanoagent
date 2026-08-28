import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeMetadataSources } = require('../../../../src/server/server-utils.js');

// Characterization test for how mergeMetadataSources (server/server-utils.js,
// the function around lines 311 to 360) treats source field names that collide
// with an Object.prototype member.
//
// The forbidden set METADATA_FORBIDDEN_FIELDS (line 16) is exactly three names:
// __proto__, constructor, and prototype. Those are skipped on the merge path.
// Every other name, including member names like `valueOf` and `toString`, is an
// ordinary field: it is collected and kept in the merged output under normal
// SOURCE_ORDER precedence.
//
// Each source is built with JSON.parse rather than an object literal. JSON.parse
// yields real own enumerable data keys for every name; object-literal syntax
// treats `{ __proto__: x }` specially (it sets the prototype instead of adding
// an own key), so JSON.parse is the unambiguous way to exercise the guard. The
// same builder is used for `valueOf` and `toString` so all cases stay uniform.
//
// Every expected value below was captured by running the real module; nothing is
// guessed. The function is pure and deterministic (no clock, randomness,
// network, or filesystem).
describe('mergeMetadataSources keeps Object-member field names', () => {
  it('keeps source own-data fields named after Object.prototype members (valueOf, toString)', () => {
    // valueOf and toString are real own data fields here, not inherited methods.
    // Neither is forbidden, so both are carried into the merged record.
    const result = mergeMetadataSources(
      JSON.parse('{"crossref":{"valueOf":"v","toString":"t","title":"T"}}'),
    );

    assert.deepStrictEqual(
      result,
      JSON.parse('{"valueOf":"v","toString":"t","title":"T"}'),
    );

    // They land as genuine own fields, shadowing the inherited members.
    assert.ok(Object.hasOwn(result, 'valueOf'));
    assert.ok(Object.hasOwn(result, 'toString'));
    assert.equal(result.valueOf, 'v');
    assert.equal(result.toString, 't');
    assert.equal(result.title, 'T');
  });

  it('applies SOURCE_ORDER precedence to a member-named field (crossref over dblp)', () => {
    // Both crossref and dblp supply a `valueOf` field. SOURCE_ORDER lists
    // crossref first, so the crossref value wins, just as for any normal field.
    const result = mergeMetadataSources(
      JSON.parse('{"crossref":{"valueOf":"cv"},"dblp":{"valueOf":"dv"}}'),
    );

    assert.deepStrictEqual(result, JSON.parse('{"valueOf":"cv"}'));
    assert.ok(Object.hasOwn(result, 'valueOf'));
    assert.equal(result.valueOf, 'cv');
  });

  it('drops only __proto__/constructor/prototype, keeping other member-named fields', () => {
    // One source carries all three forbidden keys alongside valueOf, toString,
    // and title. The merge skips exactly the forbidden three and keeps the
    // member-named survivors, pinning that the forbidden set is precisely those
    // three names and no others.
    const result = mergeMetadataSources(
      JSON.parse(
        '{"crossref":{"__proto__":{"polluted":true},"constructor":"c","prototype":"p","valueOf":"v","toString":"t","title":"T"}}',
      ),
    );

    assert.deepStrictEqual(
      result,
      JSON.parse('{"valueOf":"v","toString":"t","title":"T"}'),
    );

    // The forbidden names never reach the output as own fields.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(Object.hasOwn(result, key), false);
    }

    // The member-named survivors are kept as own fields.
    assert.ok(Object.hasOwn(result, 'valueOf'));
    assert.ok(Object.hasOwn(result, 'toString'));

    // The output's own prototype is already pinned by the deepStrictEqual above
    // (it compares the prototype chain), so here we only confirm the separate
    // concern that the pollution-shaped __proto__ input did not leak into the
    // global Object.prototype.
    assert.equal(({}).polluted, undefined);
  });
});
