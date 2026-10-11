import React, {useCallback, useEffect, useState} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {loadWorkspaces} from '@site/src/utils/workspaces';
import pageStyles from '@site/src/css/page.module.css';
import dir from '@site/src/css/directory.module.css';
import styles from './styles.module.css';

/**
 * The other end of an invitation link.
 *
 * Readable signed out, which is the whole point: whoever arrives here has no
 * account yet and needs to know which workspace this is, who asked them, and
 * above all which address their GitHub account must have. The server serves those four
 * fields for a pending invitation and 404s everything else, so a stale link
 * cannot be used to learn that an organization has been in touch with an
 * address.
 *
 * Accepting is a different request, and it needs the session whose address the
 * invitation names. Better Auth checks that; this page only explains it.
 */

async function call(path, init) {
  const res = await apiFetch(`${API_BASE}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function Join() {
  const [invitation, setInvitation] = useState(null);
  const [account, setAccount] = useState(null);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [joinedWorkspace, setJoinedWorkspace] = useState(null);

  const id = typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('i');

  const load = useCallback(async () => {
    if (!id) {
      setStatus('gone');
      setMessage('That link is missing its invitation.');
      return;
    }
    try {
      const {invitation: found} = await call(`/api/invite/${encodeURIComponent(id)}`);
      setInvitation(found);
      setStatus('ready');
    } catch (err) {
      setStatus('gone');
      setMessage(err.message);
      return;
    }
    // Who, if anyone, is signed in here. Required here rather than imported so
    // the auth client, which initializes browser-only state, never runs at build time.
    try {
      const {authClient} = require('@site/src/utils/authClient');
      const session = await authClient.getSession();
      setAccount(session?.data?.user ?? null);
    } catch {
      setAccount(null);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // GitHub sends the browser back here, so the invitation is still on screen.
  const signIn = async () => {
    setBusy(true);
    setMessage(null);
    const {authClient} = require('@site/src/utils/authClient');
    const result = await authClient.signIn.social({provider: 'github', callbackURL: window.location.href});
    if (result?.error) {
      setMessage(result.error.message || 'GitHub sign-in failed.');
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const joined = await call(`/api/invite/${encodeURIComponent(id)}/accept`, {method: 'POST'});
      const {workspaces} = await loadWorkspaces({fresh: true});
      setJoinedWorkspace(workspaces.find(workspace => workspace.id === joined.organizationId) ?? null);
      setStatus('joined');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (status === 'loading') return <div className={pageStyles.pageContainer}><p>Loading…</p></div>;

  if (status === 'gone') {
    return (
      <div className={pageStyles.pageContainer}>
        <h1 className={dir.title}>Invitation</h1>
        <p className={dir.note}>{message}</p>
        <p className={dir.note}>Ask whoever invited you for a fresh link.</p>
      </div>
    );
  }

  if (status === 'joined') {
    return (
      <div className={pageStyles.pageContainer}>
        <h1 className={dir.title}>You are in {invitation.organization}</h1>
        <p className={dir.note}>
          Open the command bar at the bottom of any page to start talking, or see{' '}
          <Link to={joinedWorkspace
            ? `/w/${encodeURIComponent(joinedWorkspace.slug)}/people`
            : '/people'}>who else is here</Link>.
        </p>
      </div>
    );
  }

  // Signed in as somebody, but not the somebody this was sent to. Saying so is
  // the useful part: on a shared machine this is the likeliest way to arrive.
  const mismatched = account && account.email?.toLowerCase() !== invitation.email.toLowerCase();

  return (
    <div className={pageStyles.pageContainer}>
      <h1 className={dir.title}>Join {invitation.organization}</h1>
      <p className={dir.note}>
        {invitation.invitedBy} invited <strong>{invitation.email}</strong> to join as {invitation.role}.
      </p>

      {message && <p className={dir.error} role="status">{message}</p>}

      {!account && (
        <div className={styles.next}>
          <p className={dir.note}>
            Sign in with the GitHub account whose primary email is {invitation.email}{' '}
            to accept. Any other address will be refused.
          </p>
          <button type="button" className={dir.cta} onClick={signIn} disabled={busy}>
            {busy ? 'Working…' : 'Continue with GitHub'}
          </button>
        </div>
      )}

      {mismatched && (
        <div className={styles.next}>
          <p className={dir.note}>
            You are signed in as {account.email}, and this invitation is for{' '}
            {invitation.email}. Sign out and back in with the GitHub account whose primary
            email is the invited address.
          </p>
        </div>
      )}

      {account && !mismatched && (
        <div className={styles.next}>
          <button type="button" className={dir.cta} onClick={accept} disabled={busy}>
            {busy ? 'Joining…' : `Join ${invitation.organization}`}
          </button>
        </div>
      )}
    </div>
  );
}

export default function JoinPage() {
  return (
    <Layout title="Join" description="Accept an invitation to a workspace" noFooter>
      <BrowserOnly fallback={<div className={pageStyles.pageContainer}><p>Loading…</p></div>}>
        {() => <Join />}
      </BrowserOnly>
    </Layout>
  );
}
