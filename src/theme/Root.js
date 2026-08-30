import React, { useEffect, useState } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import PageTracker from '@site/src/components/Analytics/PageTracker';

/**
 * The auth gate.
 *
 * Sessions come from Better Auth against the local SQL database, so this runs
 * entirely against our own API server; there is no third-party identity
 * service. `ENABLE_AUTH` decides whether the gate exists at all, and it is the
 * same flag the API server reads, so the two can never disagree about whether
 * a session is required.
 *
 * With `devAutoLogin` the gate signs itself in as root instead of showing the
 * form. That is a convenience for `npm start` and nothing more: the server
 * refuses the same request outside development or from anywhere but loopback,
 * so this flag alone cannot produce a session.
 *
 * Children stay mounted but hidden while the session resolves, rather than
 * being withheld: the search indexer reads them during the static build, and
 * unmounting would also throw away scroll position on every reload.
 */

/**
 * Marks that auto-login has already been tried in this tab.
 *
 * Without it a failing auto-login is an infinite reload: no session, so try,
 * so reload, so no session. One attempt per tab, then fall back to the form,
 * which can at least show what went wrong.
 */
const AUTOLOGIN_TRIED = 'mochi.autologin-tried';

function hidden(children) {
  return (
    <div style={{ visibility: 'hidden', position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
      {children}
    </div>
  );
}

function AuthGate({ children, devAutoLogin }) {
  // Required lazily, inside BrowserOnly, because the auth client reaches for
  // localStorage and would run during the static build otherwise.
  const { useSession, setStoredToken } = require('@site/src/utils/authClient');
  const AuthScreen = require('@site/src/theme/Root/AuthScreen').default;
  const API_BASE = require('@site/src/utils/api').default;

  const { data: session, isPending } = useSession();
  const [autoLoginDone, setAutoLoginDone] = useState(false);

  const shouldAutoLogin =
    devAutoLogin &&
    !isPending &&
    !session?.user &&
    !autoLoginDone &&
    window.sessionStorage.getItem(AUTOLOGIN_TRIED) !== '1';

  useEffect(() => {
    if (!shouldAutoLogin) return;
    let cancelled = false;

    // Recorded before the request, not after: a reload triggered by a partial
    // success must still count as an attempt.
    window.sessionStorage.setItem(AUTOLOGIN_TRIED, '1');

    fetch(`${API_BASE}/api/dev-login`, { method: 'POST' })
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (ok && body.token) {
          setStoredToken(body.token);
          window.location.reload();
          return;
        }
        // Refused, which is what production and non-loopback callers get.
        // Fall through to the ordinary sign-in form.
        setAutoLoginDone(true);
      })
      .catch(() => { if (!cancelled) setAutoLoginDone(true); });

    return () => { cancelled = true; };
  }, [shouldAutoLogin, API_BASE, setStoredToken]);

  if (isPending || shouldAutoLogin) return hidden(children);
  if (!session?.user) return <AuthScreen />;
  return <>{children}</>;
}

export default function Root({ children }) {
  const { siteConfig } = useDocusaurusContext();
  const authEnabled = siteConfig.customFields?.authEnabled;
  const devAutoLogin = siteConfig.customFields?.devAutoLogin;

  if (!authEnabled) {
    return (
      <>
        {children}
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
