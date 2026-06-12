import React, { useEffect, useState } from 'react';
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import PageTracker from '@site/src/components/Analytics/PageTracker';

const PUBLISHABLE_KEY =
  typeof process !== 'undefined' && process.env?.REACT_APP_CLERK_PUBLISHABLE_KEY
    ? process.env.REACT_APP_CLERK_PUBLISHABLE_KEY
    : 'pk_test_dW5pcXVlLXJheS0yOS5jbGVyay5hY2NvdW50cy5kZXYk';

const mobileStyles = `
/* Phones use viewport-relative units to scale fluidly with device width; tablets below use fixed px and rem sizes */

/* Small phones (up to 390px, e.g. iPhone SE, iPhone 13 mini) */
@media (max-width: 390px) {
  .auth-page {
    padding: 1.5rem !important;
    justify-content: flex-start !important;
    padding-top: 2rem !important;
  }
  .auth-logo { width: 16vw !important; height: 16vw !important; }
  .auth-title { font-size: 7vw !important; }
  .auth-tagline { font-size: 3.8vw !important; }
  .auth-notice { font-size: 3.5vw !important; margin-bottom: 1rem !important; }
}

/* Large phones (391px–767px, e.g. iPhone 14/15, Pixel, Galaxy S) */
@media (min-width: 391px) and (max-width: 767px) {
  .auth-page {
    padding: 1.5rem !important;
    justify-content: flex-start !important;
    padding-top: 2.5rem !important;
  }
  .auth-logo { width: 14vw !important; height: 14vw !important; }
  .auth-title { font-size: 6vw !important; }
  .auth-tagline { font-size: 3.2vw !important; }
  .auth-notice { font-size: 3vw !important; margin-bottom: 1.5rem !important; }
}

/* Tablets (768px–1023px, e.g. iPad) */
@media (min-width: 768px) and (max-width: 1023px) {
  .auth-logo { width: 100px !important; height: 100px !important; }
  .auth-title { font-size: 2.5rem !important; }
  .auth-tagline { font-size: 1.2rem !important; }
  .auth-notice { font-size: 1.1rem !important; }
}

/* Large tablets (1024px–1366px, e.g. iPad Pro) */
@media (min-width: 1024px) and (max-width: 1366px) {
  .auth-logo { width: 110px !important; height: 110px !important; }
  .auth-title { font-size: 2.8rem !important; }
  .auth-tagline { font-size: 1.3rem !important; }
  .auth-notice { font-size: 1.1rem !important; }
}
`;

const clerkAppearance = {
  elements: {
    card: {
      borderRadius: '16px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
      maxWidth: '100%',
    },
    rootBox: {
      width: '100%',
      maxWidth: '400px',
    },
    formButtonPrimary: {
      backgroundColor: '#2568c2',
      '&:hover': { backgroundColor: '#1a4888' },
    },
    footerActionLink: {
      color: '#2568c2',
    },
  },
};

function AuthGate({ children }) {
  const [isMobile, setIsMobile] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  // Ensure viewport meta tag exists for mobile scaling.
  // Docusaurus adds this normally, but the auth gate renders before Docusaurus loads.
  useEffect(() => {
    setAuthReady(true);
    if (!document.querySelector('meta[name="viewport"]')) {
      const meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'width=device-width, initial-scale=1';
      document.head.appendChild(meta);
    }
    const mq = window.matchMedia('(max-width: 767px)');
    setIsMobile(mq.matches);
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const appearance = {
    ...clerkAppearance,
    ...(isMobile && {
      variables: { fontSize: '0.8rem' },
    }),
  };

  // Children are always in the DOM so the search indexer can see them during SSR.
  // Before Clerk resolves auth, children are hidden (visibility: hidden) to prevent
  // a flash of content to unauthorized users. Once auth is ready, SignedIn/SignedOut
  // controls visibility properly.
  return (
    <>
      {!authReady ? (
        <div style={{ visibility: 'hidden', position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
          {children}
        </div>
      ) : (
        <SignedIn>{children}</SignedIn>
      )}
      {authReady && (
      <SignedOut>
        <style dangerouslySetInnerHTML={{ __html: mobileStyles }} />
        <div className="auth-page" style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          padding: '1rem',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        }}>
          <div className="auth-branding" style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: '1.5rem',
          }}>
            <img
              src="/img/mochi.jpg"
              alt="Mochi Lab"
              className="auth-logo"
              style={{
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                marginBottom: '1rem',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
              }}
            />
            <h1 className="auth-title" style={{
              color: '#ffffff',
              fontSize: '2rem',
              fontWeight: 700,
              margin: 0,
              letterSpacing: '-0.02em',
            }}>
              Mochi Lab
            </h1>
            <p className="auth-tagline" style={{
              color: '#94a3b8',
              fontSize: '1rem',
              margin: '0.5rem 0 0 0',
            }}>
              Innovative Research &amp; Development
            </p>
          </div>
          <p className="auth-notice" style={{
            color: '#cbd5e1',
            fontSize: '0.9rem',
            marginBottom: '1rem',
            textAlign: 'center',
            lineHeight: 1.5,
          }}>
            Invite-only. Contact the admin to request access.
          </p>
          <div className="auth-widget">
            <SignIn appearance={appearance} />
          </div>
        </div>
      </SignedOut>
      )}
    </>
  );
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
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <AuthGate>
        {children}
      </AuthGate>
      <PageTracker />
    </ClerkProvider>
  );
}
