import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');
const { SET_ROLE_RE } = analyticsUsersRoutes;

// Pure regex unit tests for the set-role route matcher that the
// PUT /api/users/:id/role handler uses to guard its dispatch. The literal was
// hoisted to a single module-scope constant so the RegExp is built once at module
// load instead of re-allocated on every request that falls through to this check.
// The pattern is stateless (no /g, no /y), and .test() on a non-global regex never
// reads or mutates lastIndex, so one shared instance returns the same boolean on
// every call; these tests pin both that contract and the exact route shape.
describe('SET_ROLE_RE', () => {
  it('is a stateless RegExp (no global or sticky flag)', () => {
    assert.ok(SET_ROLE_RE instanceof RegExp);
    assert.equal(SET_ROLE_RE.global, false);
    assert.equal(SET_ROLE_RE.sticky, false);
  });

  it('is the same instance on repeated access (hoisted once, not rebuilt)', () => {
    const again = require('../server/routes/analytics-users.js').SET_ROLE_RE;
    assert.equal(SET_ROLE_RE, again);
  });

  it('matches a well-formed set-role path', () => {
    assert.equal(SET_ROLE_RE.test('/api/users/alice/role'), true);
  });

  it('rejects a trailing extra segment', () => {
    assert.equal(SET_ROLE_RE.test('/api/users/alice/role/extra'), false);
  });

  it('rejects a path missing the /role suffix', () => {
    assert.equal(SET_ROLE_RE.test('/api/users/alice'), false);
  });

  it('rejects an empty id segment', () => {
    assert.equal(SET_ROLE_RE.test('/api/users//role'), false);
  });

  it('returns the same boolean across repeated calls (no lastIndex drift)', () => {
    assert.equal(SET_ROLE_RE.test('/api/users/alice/role'), true);
    assert.equal(SET_ROLE_RE.test('/api/users/alice/role'), true);
  });
});
