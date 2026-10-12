import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke, migratedDatabase, TEST_ORG_ID} from '../../../_harness.mjs';

const require = createRequire(import.meta.url);
const {createGithubUsers} = require('../../../../../src/server/github-users.js');

const routes = loadRoute('misc-tools');
const requestContext = Object.freeze({
  userId: 'test-user', workspaceId: TEST_ORG_ID, membershipId: 'member-1', role: 'owner',
});
const scope = {workspaceId: TEST_ORG_ID, userId: 'test-user'};

function notesCtx(githubLogin) {
  const db = migratedDatabase();
  db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, "githubLogin")
    VALUES ('test-user', 'Test', 'test@test.invalid', 1, 0, 0, ?)`).run(githubLogin);
  const ctx = makeCtx({githubUsers: createGithubUsers({db})});
  ctx.workspaceSettings.update(requestContext, {
    collections: [{key: 'notes', type: 'blog', pathPrefix: 'posts/blog', title: 'Notes'}],
  });
  return ctx;
}

const capture = ctx => invoke(routes, {
  method: 'POST', path: '/api/quicknote', body: {text: 'An idea', title: 'Idea'}, ctx, requestContext,
});

describe('POST /api/quicknote author', () => {
  it('names the caller as the author by GitHub username', async () => {
    const ctx = notesCtx('octocat');
    const response = await capture(ctx);
    assert.equal(response.status, 200);
    const note = await ctx.documents.get(scope, response.payload.path);
    assert.match(note.markdown, /^authors: \[octocat\]$/m);
  });

  it('refuses a caller whose GitHub username Mochi has not recorded', async () => {
    const response = await capture(notesCtx(null));
    assert.equal(response.status, 409);
    assert.equal(response.payload.code, 'github-login-unknown');
  });
});
