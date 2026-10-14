'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// The one public read of the platform's sign-up policy, /api/signup-policy,
// which tells the sign-in screen whether to offer sign-up. The policy itself
// lives in postgres/tenancy.js.

module.exports = async function signup_policy_routes(req, res, url, pathname, ctx) {
  const {json, tenancy} = ctx;

  if (req.method === 'GET' && pathname === '/api/signup-policy') {
    const policy = tenancy ? await tenancy.policy() : null;
    return json(res, 200, {signupMode: policy?.signupMode ?? 'open'});
  }
};
