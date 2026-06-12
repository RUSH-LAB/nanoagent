import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeMetadataSources } = require('../server/server-utils.js');

// mergeAuthorLists is internal (only mergeMetadataSources is exported), so it is
// exercised here through mergeMetadataSources, whose author union runs the merge
// over the present sources in the fixed order ['crossref', 'dblp', 'semanticScholar'].
//
// This guards the loop-invariant hoist of splitAuthorName(name) out of the
// per-author findIndex scan. The hoist must stay behavior-preserving: the merged
// list (dedup decisions, first-seen order, and which spelling wins) must be
// byte-identical to the pre-hoist algorithm.
describe('mergeAuthorLists name-split hoist (via mergeMetadataSources)', () => {
  it('matches an independent hand-derived pre-hoist reference across name-format collisions', () => {
    // One fixture exercising every branch of the merge at once:
    //   - initial collapses into a fuller spelling, which then wins ("J. Smith" -> "Jane Smith")
    //   - same family, distinct given names stay separate ("John Doe" vs "Jane Doe")
    //   - a later initial collapses into an existing fuller spelling without replacing it ("J. Doe" -> "John Doe")
    //   - a different family is appended ("Richard Roe")
    //   - an exact duplicate from a later source is dropped ("Jane Smith" again)
    const sources = {
      crossref:        { authors: ['J. Smith', 'John Doe', 'Jane Doe'] },
      dblp:            { authors: ['Jane Smith', 'J. Doe', 'Richard Roe'] },
      semanticScholar: { authors: ['Jane Smith'] },
    };

    // Hand-derived by tracing the original (pre-hoist) algorithm over the sources
    // in ['crossref', 'dblp', 'semanticScholar'] order:
    //   crossref:  push "J. Smith"; "John Doe" (smith != doe) push; "Jane Doe" (john != jane) push
    //              -> ["J. Smith", "John Doe", "Jane Doe"]
    //   dblp:      "Jane Smith" matches "J. Smith" (jane startsWith j), fuller wins -> slot 0 = "Jane Smith"
    //              "J. Doe" matches the first j-Doe, "John Doe", initial does not replace the fuller spelling
    //              "Richard Roe" (new family) push
    //              -> ["Jane Smith", "John Doe", "Jane Doe", "Richard Roe"]
    //   s2:        "Jane Smith" already present, equal length, no change
    // Final:
    const expected = ['Jane Smith', 'John Doe', 'Jane Doe', 'Richard Roe'];

    const merged = mergeMetadataSources(sources);
    assert.deepEqual(merged.authors, expected);
  });

  it('is stable across repeated calls (no hidden per-call state in the name split)', () => {
    // splitAuthorName strips initial dots with a shared /g regex via replace, so a
    // second run must yield an identical merge with no carried-over lastIndex state.
    const sources = {
      crossref:        { authors: ['J. Smith', 'John Doe', 'Jane Doe'] },
      dblp:            { authors: ['Jane Smith', 'J. Doe', 'Richard Roe'] },
      semanticScholar: { authors: ['Jane Smith'] },
    };
    const first = mergeMetadataSources(sources);
    const second = mergeMetadataSources(sources);
    assert.deepEqual(second.authors, first.authors);
  });

  it('hoists the incoming name parse to a single const pName = splitAuthorName(name)', () => {
    // Source-slice guard: the incoming name is parsed once, and the old inline
    // per-probe re-parse callback is gone.
    const src = readFileSync(new URL('../server/server-utils.js', import.meta.url), 'utf8');
    assert.ok(
      src.includes('const pName = splitAuthorName(name)'),
      'expected mergeAuthorLists to hoist the name parse into `const pName = splitAuthorName(name)`',
    );
    assert.ok(
      !src.includes('sameAuthor(existing, name)'),
      'expected the per-probe `sameAuthor(existing, name)` re-parse to be gone',
    );
  });
});
