import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {isGatedPageRequest, isOpenPage, signInUrl, nextFrom} = require('../../../../src/utils/signIn.js');

const page = (url, accept = 'text/html,application/xhtml+xml') => ({method: 'GET', url, headers: {accept}});

describe('sign-in gate', () => {
  it('gates navigations to application pages', () => {
    assert.equal(isGatedPageRequest(page('/')), true);
    assert.equal(isGatedPageRequest(page('/tasks?view=week')), true);
    assert.equal(isGatedPageRequest(page('/w/team/channels')), true);
    assert.equal(isGatedPageRequest(page('/404.html')), true);
  });

  it('lets through the sign-in page, invitations, and published documents', () => {
    for (const url of ['/signin', '/signin/', '/join', '/join/abc', '/w/team/documents', '/w/team/documents/intro']) {
      assert.equal(isOpenPage(new URL(url, 'http://x').pathname), true, url);
      assert.equal(isGatedPageRequest(page(url)), false, url);
    }
    assert.equal(isOpenPage('/joinery'), false);
  });

  it('lets through files and requests that are not navigations', () => {
    assert.equal(isGatedPageRequest(page('/assets/js/main.js')), false);
    assert.equal(isGatedPageRequest(page('/img/mochi.jpg')), false);
    assert.equal(isGatedPageRequest(page('/tasks', 'application/json')), false);
    assert.equal(isGatedPageRequest({method: 'POST', url: '/tasks', headers: {accept: 'text/html'}}), false);
  });

  it('remembers the destination and only returns to this site', () => {
    const url = new URL(signInUrl('/tasks?view=week#today'), 'http://x');
    assert.equal(url.pathname, '/signin');
    assert.equal(nextFrom(url.search), '/tasks?view=week#today');
    assert.equal(nextFrom(''), '/');
    assert.equal(nextFrom('?next=https://evil.example'), '/');
    assert.equal(nextFrom('?next=//evil.example'), '/');
    assert.equal(nextFrom('?next=/\\evil.example'), '/');
  });
});
