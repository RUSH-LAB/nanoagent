import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors the message search filter in server/routes/discussions.js
// (GET /api/discussions/:id/messages/search). Missing `text` and `author`
// default to empty strings so malformed, legacy, or imported messages are
// skipped instead of throwing a TypeError that turns the endpoint into a 500.
function searchMessages(messages, query) {
  const q = (query || '').toLowerCase().trim();
  return (messages || []).filter(m =>
    (m.text || '').toLowerCase().includes(q) || (m.author || '').toLowerCase().includes(q)
  );
}

describe('discussions message search', () => {
  const messages = [
    {id: '1', author: 'Alice', text: 'Hello world'},
    {id: '2', author: 'Bob', text: 'Graph neural networks'},
    {id: '3', author: 'Carol', text: 'Another message about graphs'},
  ];

  it('matches on message text', () => {
    const results = searchMessages(messages, 'graph');
    assert.deepEqual(results.map(m => m.id), ['2', '3']);
  });

  it('matches on author name', () => {
    const results = searchMessages(messages, 'alice');
    assert.deepEqual(results.map(m => m.id), ['1']);
  });

  it('is case-insensitive', () => {
    assert.deepEqual(searchMessages(messages, 'HELLO').map(m => m.id), ['1']);
  });

  it('returns no results when nothing matches', () => {
    assert.deepEqual(searchMessages(messages, 'zzzznomatch'), []);
  });

  // Regression: a single message missing `text` or `author` (legacy or imported
  // data, or a future message shape) must not throw a TypeError that turns the
  // search endpoint into a 500. The malformed entries are simply skipped.
  it('does not throw on messages with missing text or author fields', () => {
    const malformed = [
      {id: 'a', author: 'Dave', text: 'searchable content'},
      {id: 'b', author: 'Eve'},                  // missing text
      {id: 'c', text: 'has text but no author'}, // missing author
      {id: 'd'},                                 // missing both
      {id: 'e', author: null, text: null},       // explicit nulls
    ];
    let results;
    assert.doesNotThrow(() => { results = searchMessages(malformed, 'searchable'); });
    // Only the genuine match comes back; malformed entries never crash the filter.
    assert.deepEqual(results.map(m => m.id), ['a']);
  });

  // Documents the bug the guard fixes: the previous unguarded filter read
  // `m.text.toLowerCase()` directly, which throws on a message missing `text`.
  it('unguarded field access throws on malformed messages (why the guard exists)', () => {
    const malformed = [{id: 'b', author: 'Eve'}]; // no text field
    assert.throws(
      () => malformed.filter(m => m.text.toLowerCase().includes('x')),
      TypeError,
    );
  });
});
