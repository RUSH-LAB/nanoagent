import React, { lazy, Suspense, useEffect, useState } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { useLocation } from '@docusaurus/router';
import PageTracker from '@site/src/components/Analytics/PageTracker';
import {clientPlatform} from '@site/src/platform/client';

const CommandBar = lazy(() => import('@site/src/components/CommandBar'));
const AuthScreen = lazy(() => import('@site/src/theme/Root/AuthScreen'));
const OnboardingScreen = lazy(() => import('@site/src/theme/Root/OnboardingScreen'));

function Deferred({children}) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

function IdleCommandBar() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const show = () => setReady(true);
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(show, {timeout: 1000});
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(show, 150);
    return () => window.clearTimeout(id);
  }, []);
  return ready ? <Deferred><CommandBar /></Deferred> : null;
}

/**
 * The auth gate.
 *
 * Sessions come from Better Auth against the local SQL database, so this runs
 * entirely against our own API server; there is no third-party identity
 * service. `ENABLE_AUTH` decides whether the gate exists at all, and it is the
 * same flag the API server reads, so the two can never disagree about whether
 * a session is required.
 *
 * The workspace list doubles as the session probe: it is already protected by
 * the server's identity gate and returns the verified user id. That keeps cold
 * startup to one request instead of fetching a session and then memberships.
 *
 * Signing in is not the whole of arriving. Channels, direct messages, the people
 * directory, and invitations all belong to an organization, and an account in
 * none of them would be let through to find every one of those answering 409.
 * An empty workspace answer sends the user to OnboardingScreen to create a
 * workspace or open an invitation.
 *
 * Children remain visible while that short request resolves. Protected data is
 * never in the static shell and still comes only from authenticated APIs, so
 * first paint need not wait on the network.
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

function AuthGate({ children, devAutoLogin, googleAuthEnabled }) {
  // Required lazily, inside BrowserOnly, because workspace discovery reads the
  // authenticated API and should never run during the static build.
  const { loadWorkspaces } = require('@site/src/utils/workspaces');
  const [status, setStatus] = useState(CHECKING);
  const [detail, setDetail] = useState(null);
  const [user, setUser] = useState(null);
  // null until asked, then the number of workspaces this account belongs to.
  const [workspaces, setWorkspaces] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // /api/workspaces is already behind the server's session gate. It answers
    // both "who is signed in?" and "where can they go?", avoiding a second
    // Better Auth request on every cold application load.
    loadWorkspaces({fresh: true})
      .then((workspaceData) => {
        if (cancelled) return;
        setUser({id: workspaceData.userId});
        // Asked before the site is shown rather than after, so nobody sees a
        // workspace's worth of empty pages first. A failure here counts as
        // "has one": the workspace screen is for an account that provably has
        // none, and showing it because a request failed would strand somebody
        // whose workspace is fine.
        setWorkspaces(workspaceData?.memberships?.length ?? 1);
        setStatus(SIGNED_IN);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.status === 401) {
          setStatus(SIGNED_OUT);
          return;
        }
        // A network failure is not the same as being signed out, and telling
        // someone to sign in when the API server is down wastes their time.
        setStatus(UNREACHABLE);
        setDetail(err?.message || 'The API server did not respond.');
      });
    return () => { cancelled = true; };
  }, []);

  // The router's location, not window's. Leaving /join is a client-side route
  // change, and a pathname read from window during one render would still say
  // /join on the next.
  const ungated = isUngated(useLocation().pathname);

  // The static shell is safe to paint immediately: protected data only arrives
  // from authenticated API calls. Keeping it visible avoids a blank first
  // screen while the short session check completes.
  if (status === CHECKING) return <>{children}</>;

  if (status === SIGNED_IN) {
    if (workspaces === 0 && !ungated) {
      return (
        <Deferred>
          <OnboardingScreen
            user={user}
            onSignOut={() => import('@site/src/utils/authClient')
              .then(({signOutAndForget}) => signOutAndForget())
              .then(() => clientPlatform.location.reload())}
          />
        </Deferred>
      );
    }
    // The CLI is mounted here rather than in Layout, which Docusaurus tears
    // down and rebuilds on every navigation: a conversation you can walk away
    // from is the difference between a window docked to the app and a widget
    // stuck to the page. It sits beside the children rather than inside them,
    // so the screens that replace the children never carry it, and it waits
    // for a workspace, because every request it makes needs one.
    return <>{children}{workspaces === 0 ? null : <IdleCommandBar />}</>;
  }

  if (ungated) return <>{children}</>;

  return (
    <Deferred>
      <AuthScreen
        devAutoLogin={devAutoLogin}
        googleAuthEnabled={googleAuthEnabled}
        unreachable={status === UNREACHABLE ? detail : null}
      />
    </Deferred>
  );
}

export default function Root({ children }) {
  const { siteConfig } = useDocusaurusContext();
  const authEnabled = siteConfig.customFields?.authEnabled;
  const devAutoLogin = siteConfig.customFields?.devAutoLogin;
  const googleAuthEnabled = siteConfig.customFields?.googleAuthEnabled;

  if (!authEnabled) {
    return (
      <>
        {children}
        <IdleCommandBar />
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
        {() => <AuthGate devAutoLogin={devAutoLogin} googleAuthEnabled={googleAuthEnabled}>{children}</AuthGate>}
      </BrowserOnly>
      <PageTracker />
    </>
  );
}
