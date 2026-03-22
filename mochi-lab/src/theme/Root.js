import React from 'react';
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';

const PUBLISHABLE_KEY = 'pk_test_dW5pcXVlLXJheS0yOS5jbGVyay5hY2NvdW50cy5kZXYk';

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
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          padding: '1rem',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        }}>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: '1.5rem',
          }}>
            <img
              src="/img/mochi.jpg"
              alt="Mochi Lab"
              style={{
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                marginBottom: '1rem',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
              }}
            />
            <h1 style={{
              color: '#ffffff',
              fontSize: '2rem',
              fontWeight: 700,
              margin: 0,
              letterSpacing: '-0.02em',
            }}>
              Mochi Lab
            </h1>
            <p style={{
              color: '#94a3b8',
              fontSize: '1rem',
              margin: '0.5rem 0 0 0',
            }}>
              Innovative Research &amp; Development
            </p>
          </div>
          <p style={{
            color: '#cbd5e1',
            fontSize: '0.9rem',
            marginBottom: '1rem',
            textAlign: 'center',
            lineHeight: 1.5,
          }}>
            Invite-only. Contact the admin to request access.
          </p>
          <SignIn appearance={clerkAppearance} />
        </div>
      </SignedOut>
    </>
  );
}

export default function Root({ children }) {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <AuthGate>{children}</AuthGate>
    </ClerkProvider>
  );
}
