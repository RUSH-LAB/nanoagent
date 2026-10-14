import React, {useState} from 'react';
import Head from '@docusaurus/Head';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {apiRequest} from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';
import screen from '@site/src/theme/Root/authScreen.module.css';
import styles from './styles.module.css';

/**
 * Making a workspace, reached from the bottom of the workspace switcher.
 *
 * A screen of its own, like signing in, rather than a page inside the site: the
 * navbar names the workspace you are in and the command bar speaks for it, and
 * a new workspace belongs to neither (theme/Root.js leaves the command bar off).
 *
 * The server decides everything that can be refused: the name's length, the
 * short name's shape and whether it is taken, and how many workspaces this
 * account may own. Its answer is shown as it is written.
 */
function NewWorkspace() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const {organization} = await apiRequest('/api/org', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, slug: slug.trim() || undefined}),
      }, {failureLabel: 'Could not create the workspace'});
      // A full load, so the switcher and every cached list read the new one.
      clientPlatform.location.assign(`/w/${encodeURIComponent(organization.slug)}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className={screen.page}>
      <form className={screen.card} onSubmit={create}>
        <img src="/img/rush-lab.png" alt="" className={screen.logo} />
        <h1 className={screen.title}>Create a workspace</h1>
        <p className={screen.tagline}>
          A workspace has its own documents, channels, and people. You will be its owner.
        </p>

        <label className={screen.field}>
          <span>Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            placeholder="e.g. COMP 580"
            maxLength={60}
            autoFocus
            required
          />
        </label>

        <label className={screen.field}>
          <span>Short name <em>optional</em></span>
          <span className={styles.prefixed}>
            <span className={styles.prefix}>/w/</span>
            <input
              type="text"
              value={slug}
              onChange={(e) => { setSlug(e.target.value.toLowerCase()); setError(null); }}
              placeholder="made from the name"
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
            />
          </span>
          <small className={styles.help}>The workspace's address. Lowercase letters, digits, and dashes.</small>
        </label>

        {error && <p className={screen.error} role="alert">{error}</p>}

        <button type="submit" className={screen.submit} disabled={busy || name.trim().length < 2}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
        <button type="button" className={screen.switch} onClick={() => window.history.back()}>
          Cancel
        </button>
      </form>
    </div>
  );
}

export default function NewWorkspacePage() {
  return (
    <>
      <Head><title>Create a workspace</title></Head>
      <BrowserOnly fallback={null}>{() => <NewWorkspace />}</BrowserOnly>
    </>
  );
}
