'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// The RUSH Lab apps' build inputs, which name each app (desktop/scripts/stage.mjs).
const CONFIG = path.join(__dirname, '..', '..', 'desktop', 'config.yaml');
const SCHEME = /^[a-z][a-z0-9+.-]*$/;
const COMMAND = /^[a-z][a-z0-9-]*$/;

/** RUSH Lab, the release members install: config.yaml's top level. */
function releaseApp(file = CONFIG) {
  return appOf(yaml.load(fs.readFileSync(file, 'utf8')), file);
}

/**
 * The RUSH Lab app that serves this site, whose links (<scheme>://connect, ://sign-in) and
 * command on the member's PATH (<command> new, preview) the site names: npm start's local site (MOCHI_LOCAL_SITE=1,
 * scripts/dev/start-local.mjs) is RUSH Lab Dev's, config.yaml's `dev` over its top level; any
 * other site RUSH Lab's.
 */
function servedApp(env = process.env, file = CONFIG) {
  const local = env.MOCHI_LOCAL_SITE;
  if (local !== undefined && local !== '1') throw new Error(`MOCHI_LOCAL_SITE is 1 or unset, not ${local}`);
  const config = yaml.load(fs.readFileSync(file, 'utf8'));
  if (!local) return appOf(config, file);
  if (!config.dev) throw new Error(`${file} has no dev block for npm start's RUSH Lab Dev`);
  return appOf({...config, ...config.dev}, `${file}'s dev block`);
}

function appOf(config, where) {
  for (const key of ['product_name', 'label', 'scheme', 'command']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`${where} names no ${key}`);
  }
  if (!SCHEME.test(config.scheme)) throw new Error(`${where}'s scheme ${config.scheme} is not a URL scheme`);
  if (!COMMAND.test(config.command)) throw new Error(`${where}'s command ${config.command} is not a command name`);
  return {productName: config.product_name, label: config.label, scheme: config.scheme, command: config.command};
}

module.exports = {releaseApp, servedApp};
