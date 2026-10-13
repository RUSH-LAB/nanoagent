import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {asksForSession, redirectFor, isOpenPage, signInUrl, nextFrom} = require('../../../../src/utils/signIn.js');

const page = (url, accept = 'text/html,application/xhtml+xml') => ({method: 'GET', url, headers: {accept}});

describe('sign-in gate', () => {
  it('gates navigations to application pages', () => {
    for (const url of ['/', '/tasks?view=week', '/w/team/channels', '/404.html']) {
      assert.equal(asksForSession(page(url)), true, url);
      assert.equal(redirectFor(page(url), true), null, url);
    }
    assert.equal(redirectFor(page('/tasks?view=week'), false), '/signin?next=%2Ftasks%3Fview%3Dweek');
  });

  it('sends somebody signed in on from the sign-in page', () => {
    assert.equal(asksForSession(page('/signin?next=%2Ftasks')), true);
    assert.equal(redirectFor(page('/signin?next=%2Ftasks'), true), '/tasks');
    assert.equal(redirectFor(page('/signin/'), true), '/');
    assert.equal(redirectFor(page('/signin?next=%2Ftasks'), false), null);
  });

  it('lets through invitations and published documents', () => {
    for (const url of ['/join', '/join/abc', '/w/team/documents', '/w/team/documents/intro']) {
      assert.equal(isOpenPage(url), true, url);
      assert.equal(asksForSession(page(url)), false, url);
    }
    assert.equal(isOpenPage('/joinery'), false);
  });

  it('lets through files and requests that are not navigations', () => {
    assert.equal(asksForSession(page('/assets/js/main.js')), false);
    assert.equal(asksForSession(page('/img/mochi.jpg')), false);
    assert.equal(asksForSession(page('/tasks', 'application/json')), false);
    assert.equal(asksForSession({method: 'POST', url: '/tasks', headers: {accept: 'text/html'}}), false);
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
