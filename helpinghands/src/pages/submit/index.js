import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import styles from './styles.module.css';

/**
 * Submitting to a workspace (server/routes/submissions.js), for a workspace
 * whose settings ask for submissions: a plugin's public GitHub URL, and the
 * workspace's statement, which the member agrees to by submitting. The plugin is
 * published to the marketplace as theirs, and the submission records what they
 * submitted and agreed to. Below the form, an owner sees every submission and
 * any other member their own.
 */

async function send(init) {
  let response;
  try {
    response = await apiFetch(`${API_BASE}/api/submissions`, init);
  } catch {
    return {error: 'Could not reach the API server'};
  }
  const data = await response.json().catch(() => ({}));
  return response.ok ? {data} : {error: data.error || `The request failed (${response.status})`};
}

const commitUrl = ({owner, repo, commit, path}) => `https://github.com/${owner}/${repo}/tree/${commit}${path ? `/${path}` : ''}`;

function Submissions({submissions, owner}) {
  if (!submissions.length) return null;
  return (
    <section className={styles.list}>
      <h2>{owner ? 'Submissions' : 'Your submissions'}</h2>
      <ul>
        {submissions.map(({id, plugin, submitter, createdAt}) => (
          <li key={id}>
            <a href={commitUrl(plugin.repository)} target="_blank" rel="noreferrer">
              {plugin.id} {plugin.version}
            </a>
            {owner && <> by @{submitter.github}</>}
            {' · '}{new Date(createdAt).toLocaleString()}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Submit() {
  const {workspace, site, loading, error: siteError} = useWorkspaceSite();
  const statement = site?.submissions?.statement ?? null;
  const [url, setUrl] = React.useState('');
  const [agreed, setAgreed] = React.useState(false);
  const [state, setState] = React.useState({busy: false, error: null, done: null});
  const [submissions, setSubmissions] = React.useState([]);

  React.useEffect(() => {
    if (!workspace?.id || !statement) return;
    send().then(result => {
      if (result.data) setSubmissions(result.data.submissions);
    });
  }, [workspace?.id, statement]);

  if (siteError) return <p className={styles.error}>{siteError}</p>;
  if (loading || !site) return null;
  if (!statement) return <p className={styles.note}>This workspace takes no submissions.</p>;

  const submit = async event => {
    event.preventDefault();
    setState({busy: true, error: null, done: null});
    const result = await send({
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url, statement}),
    });
    if (result.error) return setState({busy: false, error: result.error, done: null});
    setUrl('');
    setAgreed(false);
    setSubmissions(current => [result.data.submission, ...current]);
    return setState({busy: false, error: null, done: result.data.submission});
  };

  return (
    <>
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span>Your plugin's public GitHub URL</span>
          <input
            type="url"
            required
            placeholder="https://github.com/you/your-plugin"
            value={url}
            onChange={event => setUrl(event.target.value)}
            disabled={state.busy}
          />
        </label>
        <label className={styles.agree}>
          <input type="checkbox" required checked={agreed} onChange={event => setAgreed(event.target.checked)} disabled={state.busy} />
          <span>{statement}</span>
        </label>
        <button type="submit" className="button button--primary" disabled={state.busy || !agreed}>
          {state.busy ? 'Checking…' : 'Submit'}
        </button>
        {state.error && <p className={styles.error}>{state.error}</p>}
        {state.done && (
          <p className={styles.done}>
            Submitted {state.done.plugin.id} {state.done.plugin.version}, from commit {state.done.plugin.repository.commit.slice(0, 7)}.
          </p>
        )}
      </form>
      <Submissions submissions={submissions} owner={workspace?.role === 'owner'} />
    </>
  );
}

export default function SubmitPage() {
  return (
    <Layout title="Submit">
      <main className={styles.page}>
        <h1>Submit your artifact</h1>
        <ErrorBoundary>
          <BrowserOnly fallback={null}>{() => <Submit />}</BrowserOnly>
        </ErrorBoundary>
      </main>
    </Layout>
  );
}
