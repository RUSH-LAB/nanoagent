#!/usr/bin/env node
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {sendMail} = require('../../src/server/mail.js');

const to = process.env.MAIL_TEST_TO;
if (!to) {
  console.error('Mail verification failed: MAIL_TEST_TO is required');
  process.exitCode = 1;
} else {
  sendMail({
    to,
    template: 'deployment-test',
    subject: 'Mochi Lab email delivery test',
    url: process.env.SITE_URL || 'https://mochi-lab.org',
    data: {purpose: 'production-readiness'},
  }).then(result => {
    console.log(JSON.stringify({ok: result.delivered, provider: result.provider, to}, null, 2));
  }).catch(error => {
    console.error(`Mail verification failed: ${error.message || error}`);
    process.exitCode = 1;
  });
}
