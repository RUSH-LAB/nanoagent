/**
 * Where a member's runs go, as GET /api/runner/status says (server/cloud-runs.js):
 * `runner` is 'cloud', RUSH Lab cloud, or 'computer', their own computer, which
 * `connected` says is connected or not; `cloud` is whether this site offers
 * RUSH Lab cloud at all.
 *
 * CommonJS, like utils/signIn.js, so the unit tests read it as the site does.
 */

/**
 * Whether the site lets the member in (theme/Root.js): their runs have somewhere
 * to go, RUSH Lab cloud, or their own computer once it is connected.
 */
function admits(status) {
  return Boolean(status) && (status.runner === 'cloud' || status.connected === true);
}

module.exports = {admits};
