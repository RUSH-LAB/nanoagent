import React, { useEffect, useState } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
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
 * Children stay mounted but hidden while the session resolves, rather than
 * being withheld: the search indexer reads them during the static build, and
 * unmounting would also throw away scroll position on every reload.
 */

/** What the gate knows about the session, and how it found out. */
const CHECKING = 'checking';
const SIGNED_IN = 'signed-in';
const SIGNED_OUT = 'signed-out';
const UNREACHABLE = 'unreachable';

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
  const { authClient } = require('@site/src/utils/authClient');
  const AuthScreen = require('@site/src/theme/Root/AuthScreen').default;

  const [status, setStatus] = useState(CHECKING);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let cancelled = false;
    authClient
      .getSession()
      .then((result) => {
        if (cancelled) return;
        if (result?.data?.user) setStatus(SIGNED_IN);
        else setStatus(SIGNED_OUT);
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

  if (status === CHECKING) return <Hidden>{children}</Hidden>;
  // The CLI is mounted here rather than in Layout, which Docusaurus tears down
  // and rebuilds on every navigation: a conversation you can walk away from is
  // the difference between a window docked to the app and a widget stuck to the
  // page. It sits beside the children rather than inside them, so the sign-in
  // screen, which replaces the children, never carries it.
  if (status === SIGNED_IN) return <>{children}<CommandBar /></>;

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
