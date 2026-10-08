import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  scopeWorkspacePath,
  workspaceSlugFromPath,
} from '../../../src/utils/workspaces.js';

describe('workspace-aware browser navigation', () => {
  it('reads and decodes the workspace slug from the URL', () => {
    assert.equal(workspaceSlugFromPath('/w/mochi%20lab/documents'), 'mochi lab');
    assert.equal(workspaceSlugFromPath('/documents'), null);
  });

  it('keeps workspace tools in the workspace of the current tab', () => {
    assert.equal(scopeWorkspacePath('/tasks', '/w/alpha/documents/a'), '/w/alpha/tasks');
    assert.equal(scopeWorkspacePath('/analytics?range=week', '/w/beta/settings'), '/w/beta/analytics?range=week');
  });

  it('keeps runtime document navigation in the current workspace', () => {
    assert.equal(
      scopeWorkspacePath('/documents/books/math/0-intro', '/w/research/documents'),
      '/w/research/documents/books/math/0-intro',
    );
  });

  it('does not rewrite global, external, or already-scoped destinations', () => {
    assert.equal(scopeWorkspacePath('/about', '/w/alpha/documents'), '/about');
    assert.equal(scopeWorkspacePath('https://example.com', '/w/alpha/documents'), 'https://example.com');
    assert.equal(scopeWorkspacePath('/w/beta/tasks', '/w/alpha/documents'), '/w/beta/tasks');
  });
});
