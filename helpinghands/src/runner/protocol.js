'use strict';

/**
 * Mochi and a member's own computer, over the one WebSocket the computer opens
 * to `PATH` (Mochi Lab's relay, runner/relay.mjs). Mochi sends NanoAgent
 * requests down it; the relay makes each against the NanoAgent on that
 * computer and streams the response back. Settings → AI also sets the
 * computer's API keys down it: Mochi Lab keeps them, and says only which are
 * set, never their values. JSON text frames, bodies base64:
 *
 *   computer → Mochi   {type: 'hello', device, keys: [{env, label, set}]}   again when keys change
 *                      {type: 'head', id, status, headers}
 *                      {type: 'chunk', id, data}
 *                      {type: 'end', id}
 *                      {type: 'saved', id}          NanoAgent runs with the keys from now on
 *                      {type: 'error', id, message}
 *   Mochi → computer   {type: 'request', id, method, path, headers, body?}
 *                      {type: 'abort', id}
 *                      {type: 'keys', id, changes}  {ENV_NAME: key, or null to remove it}
 */

const PATH = '/api/runner';

// What Mochi may ask the computer's NanoAgent: runs, installs and their pages,
// and the run folders' files (server/ai.js). Only the marketplace's packages
// stay on Mochi's own NanoAgent.
const SEGMENT = '[^/?]+';
const ROUTES = [
  ['GET', '/v1/profiles'],
  ['GET', '/v1/models'],
  ['POST', '/v1/runs'],
  ['GET', `/v1/installs/${SEGMENT}`],
  ['PUT', `/v1/installs/${SEGMENT}`],
  ['GET', `/v1/installs/${SEGMENT}/ui/${SEGMENT}/[^?]+`],
  ['POST', `/v1/workspaces/${SEGMENT}/installs/${SEGMENT}/runs`],
  ['POST', `/v1/workspaces/${SEGMENT}/installs/${SEGMENT}/tasks/${SEGMENT}/runs`],
  ['GET', `/v1/workspaces/${SEGMENT}/files`],
  ['GET', `/v1/workspaces/${SEGMENT}/files/[^?]+`],
  ['PUT', `/v1/workspaces/${SEGMENT}/files/[^?]+(?:\\?create=1)?`],
  ['DELETE', `/v1/workspaces/${SEGMENT}`],
].map(([method, pattern]) => [method, new RegExp(`^${pattern}$`)]);

/** Whether Mochi may send `method path` to the computer's NanoAgent. */
function allowed(method, path) {
  return typeof path === 'string' && !path.includes('..')
    && ROUTES.some(([m, pattern]) => m === method && pattern.test(path));
}

// The headers that cross, either way, a plugin page's own included; the relay
// adds NanoAgent's bearer token.
const HEADERS = ['content-type', 'accept', 'content-security-policy', 'cache-control'];

function pickHeaders(headers) {
  const all = new Headers(headers ?? {});
  return Object.fromEntries(HEADERS.filter(name => all.has(name)).map(name => [name, all.get(name)]));
}

module.exports = {PATH, allowed, pickHeaders};
