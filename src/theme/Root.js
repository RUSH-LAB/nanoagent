import React, { useEffect, useState } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { useLocation } from '@docusaurus/router';
import PageTracker from '@site/src/components/Analytics/PageTracker';
import CommandBar from '@site/src/components/CommandBar';

/**
 * The auth gate.
 *
 * Sessions come from Better Auth against the local SQL database, so this runs
 * entirely against our own API server; there is no third-party identity
 * service. `ENABLE_AUTH` decides whether the gate exists at all, and it is the
 * same flag the API server reads, so the two can never disagree about whether
 * a session is required.
 *
 * The session is fetched with `authClient.getSession()` rather than the
 * `useSession()` hook. The hook silently never issued the request: signing in
 * stored a working token, the page reloaded, `apiFetch` authenticated with that
 * token, and yet no GET /api/auth/get-session ever reached the server, so the
 * gate concluded nobody was signed in and showed the form again. One explicit
 * call, one piece of state, and a failure that says so.
 *
 * Signing in is not the whole of arriving. Channels, direct messages, the people
 * directory, and invitations all belong to an organization, and an account in
 * none of them would be let through to find every one of those answering 409.
 * So the gate asks a second question after the first, and an empty answer sends
 * you to OnboardingScreen to create a workspace or open an invitation.
 *
 * Children stay mounted but hidden while the session resolves, rather than
 * being withheld: the search indexer reads them during the static build, and
 * unmounting would also throw away scroll position on every reload.
 */

/** What the gate knows about the session, and how it found out. */
const CHECKING = 'checking';
const SIGNED_IN = 'signed-in';
const SIGNED_OUT = 'signed-out';
const UNREACHABLE = 'unreachable';

/**
 * The one page that has to render outside the gate.
 *
 * An invitation link is followed by somebody who has no account yet, and often
 * no idea which address to make one with. /join is written for exactly that
 * visitor: it reads the invitation without a session and says which workspace,
 * who sent it, and which address it names. Behind the gate, every invitation
 * link led to the sign-in form instead, which is the one place the answer is not.
 *
 * It is also exempt from the workspace check, because it is how somebody with no
 * workspace gets one.
 */
const UNGATED = ['/join'];

function isUngated(pathname) {
  return UNGATED.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

function Hidden({ children }) {
  return (
    <div style={{ visibility: 'hidden', position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
      {children}
    </div>
  );
}

function AuthGate({ children, devAutoLogin }) {
  // Required lazily, inside BrowserOnly, because the auth client reaches for
  // localStorage and would run during the static build otherwise.
  const { authClient, signOutAndForget } = require('@site/src/utils/authClient');
  const { loadWorkspaces } = require('@site/src/utils/workspaces');
  const AuthScreen = require('@site/src/theme/Root/AuthScreen').default;
  const OnboardingScreen = require('@site/src/theme/Root/OnboardingScreen').default;

  const [status, setStatus] = useState(CHECKING);
  const [detail, setDetail] = useState(null);
  const [user, setUser] = useState(null);
  // null until asked, then the number of workspaces this account belongs to.
  const [workspaces, setWorkspaces] = useState(null);

  useEffect(() => {
    let cancelled = false;
    authClient
      .getSession()
      .then(async (result) => {
        if (cancelled) return;
        if (!result?.data?.user) {
          setStatus(SIGNED_OUT);
          return;
        }
        setUser(result.data.user);
        // Asked before the site is shown rather than after, so nobody sees a
        // workspace's worth of empty pages first. A failure here counts as
        // "has one": the workspace screen is for an account that provably has
        // none, and showing it because a request failed would strand somebody
        // whose workspace is fine.
        try {
          const {memberships} = await loadWorkspaces();
          if (!cancelled) setWorkspaces(memberships?.length ?? 1);
        } catch {
          if (!cancelled) setWorkspaces(1);
        }
        if (!cancelled) setStatus(SIGNED_IN);
      })
      .catch((err) => {
        if (cancelled) return;
        // A network failure is not the same as being signed out, and telling
        // someone to sign in when the API server is down wastes their time.
        setStatus(UNREACHABLE);
        setDetail(err?.message || 'The API server did not respond.');
      });
    return () => { cancelled = true; };
  }, [authClient]);

  // The router's location, not window's. Leaving /join is a client-side route
  // change, and a pathname read from window during one render would still say
  // /join on the next.
  const ungated = isUngated(useLocation().pathname);

  if (status === CHECKING) return <Hidden>{children}</Hidden>;

  if (status === SIGNED_IN) {
    if (workspaces === 0 && !ungated) {
      return (
        <OnboardingScreen
          user={user}
          onSignOut={() => signOutAndForget().then(() => window.location.reload())}
        />
      );
    }
    // The CLI is mounted here rather than in Layout, which Docusaurus tears
    // down and rebuilds on every navigation: a conversation you can walk away
    // from is the difference between a window docked to the app and a widget
    // stuck to the page. It sits beside the children rather than inside them,
    // so the screens that replace the children never carry it, and it waits
    // for a workspace, because every request it makes needs one.
    return <>{children}{workspaces === 0 ? null : <CommandBar />}</>;
  }

  if (ungated) return <>{children}</>;

  return (
    <AuthScreen
      devAutoLogin={devAutoLogin}
      unreachable={status === UNREACHABLE ? detail : null}
    />
  );
}

export default function Root({ children }) {
  const { siteConfig } = useDocusaurusContext();
  const authEnabled = siteConfig.customFields?.authEnabled;
  const devAutoLogin = siteConfig.customFields?.devAutoLogin;

  if (!authEnabled) {
    return (
      <>
        {children}
        <CommandBar />
        <PageTracker />
      </>
    );
  }

  return (
    <>
      <BrowserOnly
        // During the static build there is no session to check, so the server
        // renders the content itself and the gate takes over on hydration.
        fallback={<>{children}</>}
      >
        {() => <AuthGate devAutoLogin={devAutoLogin}>{children}</AuthGate>}
      </BrowserOnly>
      <PageTracker />
    </>
  );
}
