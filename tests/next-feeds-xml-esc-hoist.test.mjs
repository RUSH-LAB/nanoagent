import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// feeds.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');
const { escapeFeedXml } = feedsRoutes;

describe('escapeFeedXml helper (hoisted feed XML escaper)', () => {
  it('is exported as a function alongside the route handler', () => {
    assert.equal(typeof feedsRoutes, 'function', 'default export is the route handler');
    assert.equal(typeof escapeFeedXml, 'function', 'escapeFeedXml is exported');
  });

  it('escapes &, < and > in the correct order', () => {
    assert.equal(escapeFeedXml('<a & b>'), '&lt;a &amp; b&gt;');
  });

  it('escapes the ampersand first so escaped entities are not double-escaped', () => {
    // & is replaced before < and >, so the ampersands introduced by &lt;/&gt;
    // are not themselves re-escaped into &amp;lt;/&amp;gt;.
    assert.equal(escapeFeedXml('&'), '&amp;');
    assert.equal(escapeFeedXml('<'), '&lt;');
    assert.equal(escapeFeedXml('>'), '&gt;');
    assert.equal(escapeFeedXml('&lt;'), '&amp;lt;');
  });

  it('escapes every occurrence, not just the first', () => {
    assert.equal(escapeFeedXml('a & b & c'), 'a &amp; b &amp; c');
    assert.equal(escapeFeedXml('<<>>'), '&lt;&lt;&gt;&gt;');
  });

  it('leaves strings without metacharacters unchanged', () => {
    assert.equal(escapeFeedXml('plain title'), 'plain title');
    assert.equal(escapeFeedXml(''), '');
  });

  it('matches the AT&T <Corp> example shared by the RSS and Atom handlers', () => {
    assert.equal(escapeFeedXml('AT&T <Corp>'), 'AT&amp;T &lt;Corp&gt;');
  });

  it('is a single stable instance across calls (hoisted, not rebuilt)', () => {
    // Capture the exported reference, invoke it repeatedly, then re-read the
    // export: it stays the same instance. This confirms the escaper is built
    // once at module load rather than rebuilt per request or per feed item (a
    // getter or factory that returned a fresh arrow each access would fail here).
    const ref = feedsRoutes.escapeFeedXml;
    ref('first & call');
    ref('second <call>');
    assert.strictEqual(feedsRoutes.escapeFeedXml, ref, 'export is the same instance after repeated calls');
    assert.strictEqual(escapeFeedXml, feedsRoutes.escapeFeedXml, 'destructured reference equals the exported property');
  });
});
