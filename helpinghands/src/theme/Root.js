import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import { useLocation } from '@docusaurus/router';
import PageTracker from '@site/src/components/Analytics/PageTracker';
import {clientPlatform} from '@site/src/platform/client';
import {isOpenPage, signInUrl} from '@site/src/utils/signIn';
import {AccountProvider} from '@site/src/utils/account';

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
 * service. The gate always applies, as the API server always requires a
 * session.
 *
 * The workspace list doubles as the session probe: it is already protected by
 * the server's identity gate and returns the signed-in account. That keeps cold
 * startup to one request instead of fetching a session and then memberships.
 *
 * Nothing is shown until that request answers, and then every page reads the
 * answer from utils/account.js instead of asking again. A page drawn before the
 * session was known would be drawn for a guess, and replaced a moment later by
 * the page for the real answer; one question with one owner leaves nothing to
 * guess. The static build has no session to ask about, so its HTML holds no
 * page either (Root, below).
 *
 * Signing in is not the whole of arriving. Channels, direct messages, the people
 * directory, and invitations all belong to an organization, and an account in
 * none of them would be let through to find every one of those answering 409.
 * An empty workspace answer sends the user to OnboardingScreen to open an
 * invitation.
 *
 * A visitor without a session never gets here on a page that needs one: the
 * server that sends the page redirects them to the sign-in page first
 * (src/utils/signIn.js).
 */

/** What the gate knows about the session, and how it found out. */
const CHECKING = 'checking';
const SIGNED_IN = 'signed-in';
const SIGNED_OUT = 'signed-out';
const UNREACHABLE = 'unreachable';

/** What useAccount() reads for an answer from GET /api/workspaces, or for nobody signed in. */
function accountOf(data, refresh) {
  return {
    account: data?.account ?? null,
    userId: data?.userId ?? null,
    workspaces: data?.workspaces ?? [],
    defaultWorkspaceId: data?.defaultWorkspaceId ?? null,
    offline: Boolean(data?.offline),
    refresh,
  };
}

function AuthGate({ children }) {
  // Required lazily, inside BrowserOnly, because workspace discovery reads the
  // authenticated API and should never run during the static build.
  const { loadWorkspaces } = require('@site/src/utils/workspaces');
  const [status, setStatus] = useState(CHECKING);
  const [detail, setDetail] = useState(null);
  const [data, setData] = useState(null);

  // Asks the server again and keeps the answer, for a page that changed it.
  const refresh = useCallback(async () => {
    const next = await loadWorkspaces({fresh: true});
    setData(next);
    return next;
  }, [loadWorkspaces]);

  useEffect(() => {
    let cancelled = false;
    // /api/workspaces is already behind the server's session gate. It answers
    // both "who is signed in?" and "where can they go?", avoiding a second
    // Better Auth request on every cold application load.
    loadWorkspaces({fresh: true})
      .then((workspaceData) => {
        if (cancelled) return;
        setData(workspaceData);
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

  const account = useMemo(() => accountOf(data, refresh), [data, refresh]);

  // The router's location, not window's. Leaving /join is a client-side route
  // change, and a pathname read from window during one render would still say
  // /join on the next.
  const {pathname} = useLocation();
  const ungated = isOpenPage(pathname);
  const signedOut = status === SIGNED_OUT && !ungated;

  // The server sends nobody without a session a page that needs one, so this
  // is a session that ended after the page was sent.
  useEffect(() => {
    if (signedOut) {
      clientPlatform.location.assign(signInUrl(
        `${pathname}${clientPlatform.location.search()}${clientPlatform.location.hash()}`,
      ));
    }
  }, [signedOut, pathname]);

  if (status === CHECKING) return null;

  if (status === SIGNED_IN) {
    const workspaces = account.workspaces.length;
    if (workspaces === 0 && !ungated) {
      return (
        <Deferred>
          <OnboardingScreen
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
    return (
      <AccountProvider value={account}>
        {children}{workspaces === 0 ? null : <IdleCommandBar />}
      </AccountProvider>
    );
  }

  if (ungated) return <AccountProvider value={account}>{children}</AccountProvider>;
  if (signedOut) return null;

  return (
    <Deferred>
      <AuthScreen unreachable={detail} />
    </Deferred>
  );
}

export default function Root({ children }) {
  return (
    <>
      <BrowserOnly
        // During the static build there is no session to check, so no page is
        // rendered into the HTML: what it would show depends on the session.
        fallback={null}
      >
        {() => <AuthGate>{children}</AuthGate>}
      </BrowserOnly>
      <PageTracker />
    </>
  );
}
