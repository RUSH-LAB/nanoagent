import React from 'react';
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';

const PUBLISHABLE_KEY = 'pk_test_dW5pcXVlLXJheS0yOS5jbGVyay5hY2NvdW50cy5kZXYk';

function AuthGate({ children }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
        }}>
          <SignIn />
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
