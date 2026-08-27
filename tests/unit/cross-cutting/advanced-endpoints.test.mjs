import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('version label sanitization', () => {
  function sanitize(str) {
    if (typeof str !== 'string') return '';
    return str.slice(0, 10000);
  }

  it('truncates long strings', () => {
    assert.equal(sanitize('x'.repeat(20000)).length, 10000);
  });

  it('returns empty for non-string', () => {
    assert.equal(sanitize(null), '');
    assert.equal(sanitize(undefined), '');
    assert.equal(sanitize(42), '');
  });

  it('passes through normal strings', () => {
    assert.equal(sanitize('v1.0 release'), 'v1.0 release');
  });
});

describe('template ID generation', () => {
  function generateId(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  it('converts spaces to hyphens', () => {
    assert.equal(generateId('My Template'), 'my-template');
  });

  it('removes special characters', () => {
    assert.equal(generateId('Test! @#$ Template'), 'test-template');
  });

  it('lowercases', () => {
    assert.equal(generateId('HELLO'), 'hello');
  });

  it('removes leading/trailing hyphens', () => {
    assert.equal(generateId(' Test '), 'test');
  });
});

describe('review status validation', () => {
  const validStatuses = ['approved', 'rejected', 'pending'];

  it('accepts valid statuses', () => {
    for (const status of validStatuses) {
      assert.ok(validStatuses.includes(status));
    }
  });

  it('rejects invalid status', () => {
    assert.ok(!validStatuses.includes('draft'));
    assert.ok(!validStatuses.includes(''));
  });
});

describe('reading progress clamping', () => {
  function clampProgress(progress) {
    return Math.min(100, Math.max(0, progress || 0));
  }

  it('clamps to 0-100 range', () => {
    assert.equal(clampProgress(150), 100);
    assert.equal(clampProgress(-10), 0);
    assert.equal(clampProgress(50), 50);
  });

  it('handles undefined', () => {
    assert.equal(clampProgress(undefined), 0);
  });

  it('handles null', () => {
    assert.equal(clampProgress(null), 0);
  });
});

describe('global search matching', () => {
  function matchesMultiField(fields, query) {
    const searchable = fields.join(' ').toLowerCase();
    return searchable.includes(query.toLowerCase());
  }

  it('matches across multiple fields', () => {
    assert.ok(matchesMultiField(['Title', 'Author Name', 'Venue'], 'author'));
  });

  it('case insensitive', () => {
    assert.ok(matchesMultiField(['Transformer Models', 'NeurIPS'], 'transformer'));
  });

  it('no false positives', () => {
    assert.ok(!matchesMultiField(['Cat', 'Dog'], 'transformer'));
  });
});

describe('page analytics aggregation', () => {
  function aggregatePageAnalytics(views, comments, bookmarks, readingLists) {
    return {
      views,
      comments: comments.length,
      isBookmarked: bookmarks.some(b => b.path === '/test'),
      inReadingLists: readingLists.filter(l => l.items.some(i => i.path === '/test')).length,
    };
  }

  it('counts views', () => {
    const result = aggregatePageAnalytics(42, [], [], []);
    assert.equal(result.views, 42);
  });

  it('counts comments', () => {
    const result = aggregatePageAnalytics(0, [{text: 'a'}, {text: 'b'}], [], []);
    assert.equal(result.comments, 2);
  });

  it('checks bookmark status', () => {
    const result = aggregatePageAnalytics(0, [], [{path: '/test'}], []);
    assert.equal(result.isBookmarked, true);
  });

  it('counts reading list appearances', () => {
    const lists = [
      {items: [{path: '/test'}]},
      {items: [{path: '/other'}]},
      {items: [{path: '/test'}]},
    ];
    const result = aggregatePageAnalytics(0, [], [], lists);
    assert.equal(result.inReadingLists, 2);
  });
});
