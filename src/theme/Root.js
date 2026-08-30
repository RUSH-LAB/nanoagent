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
 * Children stay mounted but hidden while the session resolves, rather than
 * being withheld: the search indexer reads them during the static build, and
 * unmounting would also throw away scroll position on every reload.
 */
function AuthGate({ children }) {
  // Imported lazily, inside BrowserOnly, because the auth client reaches for
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

  if (!session?.user) return <AuthScreen />;

  return <>{children}</>;
}

export default function Root({ children }) {
  const { siteConfig } = useDocusaurusContext();
  const authEnabled = siteConfig.customFields?.authEnabled;

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
        {() => <AuthGate>{children}</AuthGate>}
      </BrowserOnly>
      <PageTracker />
    </>
  );
}
