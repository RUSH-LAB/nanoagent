'use strict';
const {isDeepStrictEqual} = require('util');
const {resolveWorkspaceSite} = require('../workspace-site');
const {publishFromGithub} = require('../market-publish');

/**
 * What members submit to their workspace, for a workspace whose settings ask for
 * submissions (site.submissions: the terms its home shows, and the statement):
 *
 *   GET  /api/workspaces/{id}/submissions   every submission for an owner, a member's own otherwise
 *   POST /api/workspaces/{id}/submissions   submit {url, agreement}: the plugin folder `url`
 *                                           names in a public GitHub repository, agreeing to
 *                                           `agreement`, the workspace's {notice, statement}
 *
 * Submitting publishes the plugin to the marketplace as the member's
 * (market-publish.js), then records which version, package and commit they
 * submitted and the terms and statement they agreed to, which must be the
 * workspace's as they read now. PostgreSQL only (postgres/submissions.js).
 */
module.exports = async function submissions_routes(req, res, _url, _pathname, ctx) {
  if (!req.context || req.workspacePath !== '/submissions') return;
  const {json, readBody, rateLimit, requireWorkspacePermission, workspaceSettings, submissions, ai, github, market} = ctx;
  if (!submissions || !market) return json(res, 503, {error: 'Submissions need PostgreSQL (DATABASE_URL)'});
  requireWorkspacePermission(req.context, 'content:read');

  if (req.method === 'GET') return json(res, 200, {submissions: await submissions.list(req.context)});

  if (req.method === 'POST') {
    const asked = resolveWorkspaceSite(await workspaceSettings.get(req.context)).submissions;
    if (!asked) return json(res, 409, {error: 'This workspace takes no submissions'});
    if (!req.auth.account?.githubLogin) return json(res, 403, {error: 'Sign in with GitHub to submit: a plugin is listed by its publisher\'s GitHub account'});
    if (!await rateLimit(`market-upload:${req.context.userId}`, 10)) return json(res, 429, {error: 'Too many uploads. Try again in a minute.'});
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, {error: 'The request body must be JSON: {"url": "https://github.com/<owner>/<repo>", "agreement": {"notice": […], "statement": "…"}}'});
    }
    if (!isDeepStrictEqual(body?.agreement, asked)) {
      return json(res, 409, {error: 'What you agree to has changed. Reload the page and read it again.'});
    }
    const published = await publishFromGithub({ai, github, market}, req.context.userId, body?.url);
    if (published.error) return json(res, published.status, {error: published.error});
    return json(res, 201, {submission: await submissions.add(req.context, published.plugin, asked)});
  }

  return json(res, 405, {error: 'Method not allowed'});
};
