'use strict';

/**
 * RUSH and a member's own computer, over the one WebSocket the computer opens
 * to `PATH` (RUSH Lab's relay, runner/relay.mjs). RUSH sends NanoAgent
 * requests down it; the relay makes each against the NanoAgent on that
 * computer and streams the response back. Settings → AI also sets the
 * computer's API keys down it, and the addresses of the member's own servers
 * (SERVER_URLS): RUSH Lab keeps them, and says only which are set, never a
 * key's value. A request RUSH asks to `hold` (a plugin run) is
 * not the connection's: the relay keeps it going when the connection drops,
 * with every frame it sent, for HOLD_MS, and lists it in its next `hello`, so
 * RUSH, the same process or one started since, `resume`s it from the frames
 * it has, and `release`s it once it has kept what the run did. A plugin run
 * names the workspace and plugin it is for (`files`): the computer fills its
 * folder from the member's files there and writes back what it did
 * (runner/run-files.mjs), so no file of the run crosses this socket. JSON text
 * frames, bodies base64:
 *
 *   computer → RUSH   {type: 'hello', device, keys: [{env, label, set}], runs: [id], files: true}
 *                                                    again when keys change
 *                      {type: 'head', id, status, headers}
 *                      {type: 'chunk', id, data}
 *                      {type: 'end', id}
 *                      {type: 'saved', id}          NanoAgent runs with the keys from now on
 *                      {type: 'error', id, message}
 *   RUSH → computer   {type: 'request', id, method, path, headers, body?, hold?, files?: {workspace, plugin}}
 *                      {type: 'resume', id, from}   the held request's frames from the `from`th on
 *                      {type: 'release', id}        RUSH has kept what the held request did
 *                      {type: 'abort', id}
 *                      {type: 'keys', id, changes}  {ENV_NAME: key, or null to remove it}
 */

const PATH = '/api/runner';
// How long a held request goes on without RUSH before the relay stops it.
const HOLD_MS = 10 * 60_000;

// What RUSH may ask the computer's NanoAgent: runs, installs and their pages,
// and views (the page alone of a package it refuses to install). Only the
// marketplace's packages stay on RUSH's own NanoAgent.
const SEGMENT = '[^/?]+';
const ROUTES = [
  ['GET', '/v1/profiles'],
  ['GET', '/v1/models'],
  ['GET', '/v1/keys/openrouter/usage'],
  ['POST', '/v1/runs'],
  ['GET', `/v1/installs/${SEGMENT}`],
  ['PUT', `/v1/installs/${SEGMENT}`],
  ['GET', `/v1/installs/${SEGMENT}/ui/${SEGMENT}/[^?]+`],
  ['PUT', `/v1/views/${SEGMENT}`],
  ['POST', `/v1/workspaces/${SEGMENT}/installs/${SEGMENT}/runs`],
].map(([method, pattern]) => [method, new RegExp(`^${pattern}$`)]);

/** Whether RUSH may send `method path` to the computer's NanoAgent. */
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

// The keys that are the address of a member's own server, by the engine it runs, as RUSH Lab's
// lab.mjs names them: no secret, so a `hello` gives the whole address as its hint.
const SERVER_URLS = ['VLLM_BASE_URL', 'SGLANG_BASE_URL'];

/**
 * Whether `value` is a server's address: http or https, a host, and no credentials, query or
 * fragment, as lab.mjs and NanoAgent check it again.
 */
function isServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname)
    && !url.username && !url.password && !value.includes('?') && !value.includes('#');
}

module.exports = {PATH, HOLD_MS, SERVER_URLS, allowed, isServerUrl, pickHeaders};
