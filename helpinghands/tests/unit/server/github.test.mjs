import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const {createGithub, parseRepositoryUrl, ARCHIVE_MAX_BYTES} = createRequire(import.meta.url)('../../../src/server/github.js');

const COMMIT = 'a'.repeat(40);

/** GitHub answering the commit a ref names and that commit's archive, recording each URL. */
function fakeGithub({commit = new Response(COMMIT), archive = new Response('archive')} = {}) {
  const asked = [];
  const github = createGithub({
    fetchImpl: async url => {
      asked.push(url);
      return url.startsWith('https://api.github.com/') ? commit : archive;
    },
  });
  return {github, asked};
}

describe('a plugin\'s source on GitHub', () => {
  it('reads a repository, or a ref and folder in one, from its URL', () => {
    assert.deepEqual(parseRepositoryUrl('https://github.com/alice/notes.git'), {owner: 'alice', repo: 'notes', ref: 'HEAD', path: ''});
    assert.deepEqual(parseRepositoryUrl('https://github.com/alice/tools/tree/v1.2/plugins/notes/'),
      {owner: 'alice', repo: 'tools', ref: 'v1.2', path: 'plugins/notes'});
    for (const url of [
      'http://github.com/alice/notes', 'https://gitlab.com/alice/notes', 'https://github.com/alice',
      'https://github.com/alice/notes/blob/main/README.md', 'https://github.com/alice/notes/tree',
      'https://github.com/alice/notes/tree/main/my%20notes', 'https://github.com/alice/notes?tab=readme', 'not a url',
    ]) assert.equal(parseRepositoryUrl(url), null, url);
  });

  it('pins the ref to its commit and fetches that commit\'s archive', async () => {
    const {github, asked} = fakeGithub();
    const fetched = await github.source('https://github.com/alice/tools/tree/main/plugins/notes');
    assert.deepEqual(fetched.value.repository, {owner: 'alice', repo: 'tools', ref: 'main', path: 'plugins/notes', commit: COMMIT});
    assert.equal(fetched.value.archive.toString(), 'archive');
    assert.deepEqual(asked, [
      'https://api.github.com/repos/alice/tools/commits/main',
      `https://codeload.github.com/alice/tools/tar.gz/${COMMIT}`,
    ]);
  });

  it('says why there is no source to publish', async () => {
    assert.equal((await fakeGithub().github.source('https://example.com/x')).status, 400);
    const missing = await fakeGithub({commit: new Response('', {status: 404})}).github.source('https://github.com/alice/gone');
    assert.deepEqual(missing, {error: 'GitHub has no public repository alice/gone with HEAD', status: 404});
    const huge = await fakeGithub({archive: new Response(Buffer.alloc(ARCHIVE_MAX_BYTES + 1))}).github.source('https://github.com/alice/huge');
    assert.equal(huge.status, 413);
  });
});
