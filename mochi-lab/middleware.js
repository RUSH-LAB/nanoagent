import { verifyToken } from '@clerk/backend';

export default async function middleware(request) {
  const url = new URL(request.url);

  // Skip auth for static assets and Clerk webhook endpoints
  if (
    url.pathname.startsWith('/_next') ||
    url.pathname.startsWith('/assets') ||
    url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|webmanifest)$/)
  ) {
    return; // pass through
  }

  // Get session token from cookie
  const sessionToken = request.headers
    .get('cookie')
    ?.split(';')
    .find((c) => c.trim().startsWith('__session='))
    ?.split('=')[1];

  if (sessionToken) {
    try {
      await verifyToken(sessionToken, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      return; // valid session, pass through
    } catch (e) {
      // invalid token, fall through to redirect
    }
  }

  // Redirect to Clerk hosted sign-in
  const signInUrl = `https://${process.env.CLERK_SIGN_IN_URL || 'accounts.clerk.dev'}/sign-in?redirect_url=${encodeURIComponent(request.url)}`;
  return new Response(null, {
    status: 302,
    headers: { Location: signInUrl },
  });
}
