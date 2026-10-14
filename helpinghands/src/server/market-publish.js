'use strict';

/**
 * Publish to the marketplace (routes/market.js) the plugin folder that `url`
 * names in a public GitHub repository, as `userId`'s: the commit its ref names
 * now is fetched (server/github.js), NanoAgent packs it and checks every plugin
 * rule without running it, and the package is stored (postgres/market.js).
 * Answers {status, plugin}, the listing, or {status, error}. Submitting to a
 * workspace (routes/submissions.js) publishes this way too.
 */
async function publishFromGithub({ai, github, market}, userId, url) {
  const fetched = await github.source(url);
  if (fetched.error) return {status: fetched.status, error: fetched.error};
  const {repository, archive} = fetched.value;
  const packed = await ai.packageSource(archive, repository.path);
  if (packed.error) return {status: packed.status, error: packed.error};
  const entry = packed.value.package;
  const data = Buffer.from(packed.value.data, 'base64');
  const builtIn = await ai.packages();
  if (builtIn.error) return {status: builtIn.status, error: builtIn.error};
  if (builtIn.value.packages.some(other => other.id === entry.id)) {
    return {status: 409, error: `${entry.id} is one of NanoAgent's own plugins`};
  }
  try {
    return {status: 201, plugin: await market.publish(userId, entry, data, repository)};
  } catch (error) {
    if (error.code === 'taken') return {status: 409, error: error.message};
    if (error.code === 'quota') return {status: 413, error: error.message};
    // Row-level security refused it: the id became someone else's meanwhile.
    if (error.code === '42501') return {status: 409, error: `Someone else already publishes a plugin named ${entry.id}`};
    throw error;
  }
}

module.exports = {publishFromGithub};
