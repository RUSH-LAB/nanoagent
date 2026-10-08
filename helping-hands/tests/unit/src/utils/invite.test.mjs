import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// idFromLink is authored as an ES module under src/utils (consumed by the
// Docusaurus build); Node's module-syntax detection lets this .mjs test import
// the .js source directly. linkFor is not tested here: it reads
// window.location.origin, which does not exist under the test runner.
import { idFromLink } from '../../../../src/utils/invite.js';

describe('idFromLink (the other end of an invitation link)', () => {
  it('reads the id out of a whole URL', () => {
    assert.equal(idFromLink('https://mochi.example/join?i=inv_abc123'), 'inv_abc123');
  });

  it('reads it out of the path alone, which is what a chat client often leaves', () => {
    assert.equal(idFromLink('/join?i=inv_abc123'), 'inv_abc123');
  });

  it('accepts a bare id, because people read them out', () => {
    assert.equal(idFromLink('inv_abc123'), 'inv_abc123');
  });

  it('ignores the whitespace around a paste', () => {
    assert.equal(idFromLink('  https://mochi.example/join?i=inv_abc123  \n'), 'inv_abc123');
  });

  it('finds the id among other query parameters, in either order', () => {
    assert.equal(idFromLink('/join?from=email&i=inv_abc123'), 'inv_abc123');
    assert.equal(idFromLink('/join?i=inv_abc123&from=email'), 'inv_abc123');
  });

  it('decodes an escaped id, since linkFor encodes one', () => {
    assert.equal(idFromLink('/join?i=inv%2Fabc'), 'inv/abc');
  });

  it('keeps the fragment out of the id', () => {
    assert.equal(idFromLink('/join?i=inv_abc123#top'), 'inv_abc123');
  });

  for (const [why, text] of [
    ['nothing', ''],
    ['only whitespace', '   '],
    ['null', null],
    ['undefined', undefined],
    ['a link with no invitation on it', 'https://mochi.example/join?from=email'],
    ['a URL that is not an invitation', 'https://mochi.example/people'],
    ['a sentence somebody pasted by mistake', 'come and join our workspace'],
  ]) {
    it(`answers null for ${why}`, () => {
      assert.equal(idFromLink(text), null);
    });
  }
});
