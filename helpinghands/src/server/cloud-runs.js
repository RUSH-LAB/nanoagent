'use strict';

/**
 * RUSH Lab cloud: a member's runs on Mochi's own NanoAgent (server/ai.js), on
 * a deployment that offers it (CLOUD_RUNS=on) and for a member who runs there,
 * as they choose in Settings → Connection (their `runner` preference).
 *
 * That NanoAgent is shared by every member who runs there, so it holds the
 * lab's own OpenRouter key, runs only its configured profiles, and has to
 * confine every plugin it runs: the AWS deployment starts it with bubblewrap
 * (infra/aws/runner), and NanoAgent refuses to start where that does not
 * confine. A deployment whose NanoAgent runs plugins unconfined, such as
 * Railway's (sandbox: none), never sets CLOUD_RUNS.
 *
 * Where a member's plugins run is theirs to choose, and nothing else changes
 * it: a member who runs on their computer is refused while it is not
 * connected, and one who runs here is never sent to their computer
 * (server/runner.js). A member who has not chosen runs on their computer, as
 * before this site offered RUSH Lab cloud; while that computer is not
 * connected the site offers them RUSH Lab cloud (theme/Root/LabScreen.js).
 */

const RUNNERS = Object.freeze(['cloud', 'computer']);

/** Whether `env` offers RUSH Lab cloud: CLOUD_RUNS is `on`, or unset; anything else is refused. */
function cloudRunsOffered(env) {
  const value = env.CLOUD_RUNS;
  if (value === undefined || value === '') return false;
  if (value === 'on') return true;
  throw new Error(`CLOUD_RUNS must be "on" or unset, not ${JSON.stringify(value)}`);
}

/**
 * RUSH Lab cloud for the deployment `env` describes: `gateway` is Mochi's own
 * NanoAgent, and `preferences` keeps each member's choice.
 */
function createCloudRuns({env = process.env, gateway, preferences}) {
  const offered = cloudRunsOffered(env);
  return Object.freeze({
    offered,
    gateway,

    /** Where `userId`'s plugins run: 'cloud' or 'computer'. */
    async runnerOf(userId) {
      if (!offered || !userId) return 'computer';
      return (await preferences.get(userId))?.runner === 'cloud' ? 'cloud' : 'computer';
    },

    /** Run `userId`'s plugins on `runner` from now on: `{value}`, or `{error, status}`. */
    async choose(userId, runner) {
      if (!RUNNERS.includes(runner)) return {error: 'runner must be "cloud" or "computer"', status: 400};
      if (runner === 'cloud' && !offered) return {error: 'This site does not offer RUSH Lab cloud: run on your computer', status: 409};
      await preferences.merge(userId, {runner});
      return {value: runner};
    },
  });
}

module.exports = {createCloudRuns, cloudRunsOffered, RUNNERS};
