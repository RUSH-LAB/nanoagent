import React from 'react';
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
 * With `devAutoLogin` the sign-in screen offers a one-click "Sign in as root"
 * button. It used to sign itself in with no click at all, which was a mistake:
 * to avoid an infinite reload the gate had to remember that it had already
 * tried, and that memory outlived the session it was tracking. Wiping the
 * database left tabs permanently stuck on the form with no way to ask again.
 * A button has no state to go stale, and shows what it is about to do.
 *
 * Children stay mounted but hidden while the session resolves, rather than
 * being withheld: the search indexer reads them during the static build, and
 * unmounting would also throw away scroll position on every reload.
 */
function AuthGate({ children, devAutoLogin }) {
  // Required lazily, inside BrowserOnly, because the auth client reaches for
  // localStorage and would run during the static build otherwise.
  const { useSession } = require('@site/src/utils/authClient');
  const AuthScreen = require('@site/src/theme/Root/AuthScreen').default;

  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <div style={{ visibility: 'hidden', position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        {children}
      </div>
    );
  }

  if (!session?.user) return <AuthScreen devAutoLogin={devAutoLogin} />;

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
