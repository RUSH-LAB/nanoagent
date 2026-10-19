import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {sendMail, messageHtml} = require('../../../src/server/mail.js');

describe('transactional mail', () => {
  it('delivers directly through Resend', async () => {
    const calls = [];
    const result = await sendMail({
      to: 'reader@example.test',
      template: 'email-verification',
      subject: 'Verify <RUSH>',
      url: 'https://mochi.example.test/verify?a=1&b=2',
    }, {
      env: {RESEND_API_KEY: 're_test', MAIL_FROM: 'RUSH <mail@example.test>'},
      fetchImpl: async (url, init) => {
        calls.push({url, init});
        return {ok: true, status: 200};
      },
    });
    assert.deepEqual(result, {delivered: true, provider: 'resend'});
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.to, ['reader@example.test']);
    assert.equal(body.tags[0].value, 'email-verification');
    assert.match(body.html, /Verify &lt;RUSH&gt;/);
    assert.match(body.html, /a=1&amp;b=2/);
  });

  it('keeps the HTTPS webhook fallback', async () => {
    const calls = [];
    const result = await sendMail({to: 'reader@example.test', template: 'invite', subject: 'Join', url: 'https://example.test'}, {
      env: {NODE_ENV: 'production', MAIL_WEBHOOK_URL: 'https://mail.example.test/send', MAIL_WEBHOOK_TOKEN: 'token'},
      fetchImpl: async (url, init) => { calls.push({url: String(url), init}); return {ok: true, status: 200}; },
    });
    assert.deepEqual(result, {delivered: true, provider: 'webhook'});
    assert.equal(calls[0].url, 'https://mail.example.test/send');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token');
  });

  it('requires both Resend settings and escapes generated HTML', async () => {
    await assert.rejects(
      sendMail({to: 'a@example.test', subject: 'x', url: 'https://example.test'}, {env: {RESEND_API_KEY: 're_test'}}),
      /configured together/,
    );
    assert.equal(messageHtml({subject: '<b>x</b>', url: 'https://example.test/?a=1&b=2'}).includes('<b>'), false);
  });

  it('includes the provider error message without exposing credentials', async () => {
    await assert.rejects(
      sendMail({to: 'a@example.test', template: 'test', subject: 'x', url: 'https://example.test'}, {
        env: {RESEND_API_KEY: 're_secret', MAIL_FROM: 'RUSH <mail@example.test>'},
        fetchImpl: async () => ({
          ok: false,
          status: 403,
          async json() { return {message: 'The example.test domain is not verified'}; },
        }),
      }),
      error => error.message.includes('domain is not verified') && !error.message.includes('re_secret'),
    );
  });
});
