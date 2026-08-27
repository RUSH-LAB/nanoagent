import React from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

const ROLE_HIERARCHY = ['viewer', 'editor', 'owner'];

function hasRole(userRole, requiredRole) {
  const userLevel = ROLE_HIERARCHY.indexOf(userRole);
  const requiredLevel = ROLE_HIERARCHY.indexOf(requiredRole);
  if (userLevel === -1 || requiredLevel === -1) return false;
  return userLevel >= requiredLevel;
}

function AuthGuardWithClerk({ children, role, fallback, useUser, SignInButton, UserButton }) {
  const { isLoaded, isSignedIn, user } = useUser();

  // While Clerk is loading, show nothing to avoid a flash of wrong state.
  if (!isLoaded) {
    return null;
  }

  // Not signed in — show sign-in prompt or custom fallback.
  if (!isSignedIn) {
    if (fallback) return <>{fallback}</>;
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3rem 1.5rem',
        textAlign: 'center',
        gap: '1rem',
      }}>
        <p style={{ fontSize: '1.1rem', color: 'var(--ifm-font-color-base)', margin: 0 }}>
          You need to sign in to access this content.
        </p>
        <SignInButton mode="modal">
          <button style={{
            padding: '0.6rem 1.5rem',
            fontSize: '1rem',
            fontWeight: 600,
            color: '#fff',
            backgroundColor: '#2568c2',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
          }}>
            Sign in
          </button>
        </SignInButton>
      </div>
    );
  }

  // Signed in — check role.
  const userRole = user?.publicMetadata?.role || 'viewer';
  if (!hasRole(userRole, role)) {
    if (fallback) return <>{fallback}</>;
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3rem 1.5rem',
        textAlign: 'center',
        gap: '0.75rem',
      }}>
        <p style={{ fontSize: '1.1rem', color: 'var(--ifm-font-color-base)', margin: 0 }}>
          You don&apos;t have permission to access this content.
        </p>
        <p style={{ fontSize: '0.9rem', color: 'var(--ifm-font-color-secondary)', margin: 0 }}>
          Required role: <strong>{role}</strong>. Your role: <strong>{userRole}</strong>.
        </p>
        <UserButton />
      </div>
    );
  }

  return <>{children}</>;
}

export default function AuthGuard({ children, role = 'viewer', fallback }) {
  const { siteConfig } = useDocusaurusContext();
  const authEnabled = siteConfig.customFields?.authEnabled;

  if (!authEnabled) {
    return <>{children}</>;
  }

  let clerkHooks;
  try { clerkHooks = require('@clerk/clerk-react'); } catch { return <>{children}</>; }

  return (
    <AuthGuardWithClerk
      role={role}
      fallback={fallback}
      useUser={clerkHooks.useUser}
      SignInButton={clerkHooks.SignInButton}
      UserButton={clerkHooks.UserButton}
    >
      {children}
    </AuthGuardWithClerk>
  );
}
