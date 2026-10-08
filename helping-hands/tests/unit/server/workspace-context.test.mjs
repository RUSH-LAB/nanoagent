import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const {
  createWorkspaceContextResolver,
  normalizeWorkspaceRole,
  can,
  requirePermission,
  storageScope,
  isGlobalApiPath,
  matchWorkspaceApiPath,
  workspaceDispatchPath,
} = require('../../../src/server/workspace-context.js');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE organization (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE member (
      id TEXT PRIMARY KEY,
      organizationId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT NOT NULL
    );
    INSERT INTO organization (id, slug) VALUES ('w-a', 'alpha'), ('w-b', 'beta');
    INSERT INTO member VALUES
      ('m-a', 'w-a', 'ada', 'owner'),
      ('m-b', 'w-b', 'ada', 'member'),
      ('m-c', 'w-b', 'bob', 'admin');
  `);
  return createWorkspaceContextResolver({db});
}

describe('workspace request context', () => {
  it('joins the session user to the workspace named by the request', () => {
    const context = fixture().byId('ada', 'w-b');
    assert.deepEqual(context, {
      userId: 'ada', workspaceId: 'w-b', membershipId: 'm-b', role: 'viewer',
    });
    assert.equal(storageScope(context), context);
  });

  it('resolves browser slugs without consulting an active organization', () => {
    assert.equal(fixture().bySlug('bob', 'beta').workspaceId, 'w-b');
  });

  it('returns the same absence for an unknown workspace and a non-member', () => {
    const resolver = fixture();
    assert.equal(resolver.byId('ada', 'missing'), null);
    assert.equal(resolver.byId('bob', 'w-a'), null);
  });

  it('normalizes legacy roles to the product role model', () => {
    assert.equal(normalizeWorkspaceRole('owner'), 'owner');
    assert.equal(normalizeWorkspaceRole('admin'), 'editor');
    assert.equal(normalizeWorkspaceRole('member'), 'viewer');
    assert.equal(normalizeWorkspaceRole('unexpected'), 'viewer');
  });

  it('enforces the centralized permission matrix', () => {
    const viewer = fixture().byId('ada', 'w-b');
    assert.equal(can(viewer, 'content:read'), true);
    assert.equal(can(viewer, 'content:edit'), false);
    assert.throws(
      () => requirePermission(viewer, 'content:edit'),
      error => error.status === 403 && error.code === 'workspace-permission-denied',
    );
  });
});

describe('workspace API paths', () => {
  it('extracts an immutable workspace id and suffix', () => {
    assert.deepEqual(matchWorkspaceApiPath('/api/workspaces/w-1/chat/channels'), {
      workspaceId: 'w-1', workspacePath: '/chat/channels',
    });
  });

  it('maps public workspace resources to their transitional handlers', () => {
    assert.equal(workspaceDispatchPath('/documents/versions'), '/api/content/versions');
    assert.equal(workspaceDispatchPath('/members/m-1/role'), '/api/org/members/m-1/role');
    assert.equal(workspaceDispatchPath('/chat/channels'), '/api/chat/channels');
    assert.equal(workspaceDispatchPath('/tasks'), '/api/tasks');
  });
});

describe('global API allowlist', () => {
  it('keeps account and pre-authentication endpoints outside workspace scope', () => {
    for (const path of ['/api/health', '/api/workspaces', '/api/preferences', '/api/auth/sign-in/email', '/api/invite/token', '/api/invite/token/accept', '/api/users/u1/role']) {
      assert.equal(isGlobalApiPath(path), true, path);
    }
  });

  it('requires explicit workspace ids for business and content APIs', () => {
    for (const path of ['/api/file', '/api/graph', '/api/feed/rss', '/api/chat/channels', '/api/references']) {
      assert.equal(isGlobalApiPath(path), false, path);
    }
  });

  it('does not let route code scope content or caches from the session default', () => {
    const routesDir = path.join(root, 'src/server/routes');
    const offenders = fs.readdirSync(routesDir)
      .filter(name => name.endsWith('.js'))
      .filter(name => /(?:contentRootFor|cacheKey)\(req\.auth(?:\?\.)?orgId/.test(
        fs.readFileSync(path.join(routesDir, name), 'utf8'),
      ));
    assert.deepEqual(offenders, []);
  });
});
