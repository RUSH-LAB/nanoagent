import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeMetadataSources } = require('../../../../src/server/server-utils.js');

// Characterization test for the malformed-author skip branches of
// mergeMetadataSources (server/server-utils.js), which drive the internal
// mergeAuthorLists helper:
//
//   • the non-array guard
//       const list = Array.isArray(src.authors) ? src.authors : [];
//     so an `authors` value that is not an array (a bare string, a number, or
//     null) is treated as an empty list and contributes nothing.
//   • the per-entry skip
//       if (typeof raw !== 'string' || !raw.trim()) continue;
//     so non-string elements and empty or whitespace-only strings are dropped,
//     and each surviving name is trimmed.
//
// The four existing mergeMetadataSources tests feed only clean string arrays, so
// these two branches had no assertions. When mergeAuthorLists yields no names,
// mergeMetadataSources omits the `authors` key entirely (its `authors.length > 0`
// guard), so an all-junk list produces no key at all. Every expected value below
// was captured by running the real module; nothing here is guessed.
describe('mergeMetadataSources malformed-author skip branches', () => {
  it('treats a bare-string authors value as an empty list (non-array guard)', () => {
    // Array.isArray('John Doe') is false, so the list becomes [] and no author
    // survives; with no other fields present the merged record is empty.
    const result = mergeMetadataSources({ crossref: { authors: 'John Doe' } });
    assert.deepStrictEqual(result, {});
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'authors'), false);
  });

  it('treats a numeric authors value as an empty list (non-array guard)', () => {
    // A number also fails Array.isArray, so it contributes no authors.
    const result = mergeMetadataSources({ crossref: { authors: 42 } });
    assert.deepStrictEqual(result, {});
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'authors'), false);
  });

  it('treats a null authors value as an empty list (non-array guard)', () => {
    // null is the third non-array shape; Array.isArray(null) is false.
    const result = mergeMetadataSources({ crossref: { authors: null } });
    assert.deepStrictEqual(result, {});
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'authors'), false);
  });

  it('skips every malformed element in a mixed-junk authors array', () => {
    // The per-entry guard drops the number, null, undefined, the empty and
    // whitespace-only strings, and the object; only the one real string is kept.
    const result = mergeMetadataSources({
      crossref: { authors: [42, null, undefined, '', '   ', { name: 'x' }, 'Jane Smith'] },
    });
    assert.deepStrictEqual(result, { authors: ['Jane Smith'] });
  });

  it('omits the authors key entirely when every element is junk', () => {
    // null, an empty string, a whitespace-only string, and a number all skip, so
    // mergeAuthorLists returns [] and the length guard drops the authors key.
    const result = mergeMetadataSources({ crossref: { authors: [null, '', '  ', 7] } });
    assert.deepStrictEqual(result, {});
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'authors'), false);
  });

  it('trims a valid entry and drops a whitespace-only entry', () => {
    // '  Padded Name  ' survives and is trimmed to 'Padded Name'; the '  ' entry
    // trims to '' and is skipped by the per-entry guard.
    const result = mergeMetadataSources({ crossref: { authors: ['  Padded Name  ', '  '] } });
    assert.deepStrictEqual(result, { authors: ['Padded Name'] });
  });

  it('skips junk without breaking cross-source author dedup', () => {
    // Junk entries (null, '') are skipped in both sources, and the surviving
    // names still merge and dedup across them: 'J. Doe' collapses into the fuller
    // 'John Doe' from CrossRef, and 'Bob Lee' is appended.
    const result = mergeMetadataSources({
      crossref: { authors: [null, 'John Doe'] },
      dblp: { authors: ['', 'J. Doe', 'Bob Lee'] },
    });
    assert.deepStrictEqual(result, { authors: ['John Doe', 'Bob Lee'] });
  });
});
