import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import Markdown from '@site/src/components/CommandBar/Markdown';
import Layout from '@theme/Layout';
import PluginSidebar, {pluginNavigation} from '@site/src/components/PluginSidebar';
import ThreeColumnLayout from '@site/src/components/ThreeColumnLayout';
import useWorkspaceApps from '@site/src/hooks/useWorkspaceApps';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import styles from './styles.module.css';

/**
 * The apps NanoAgent publishes: its `nanoagent.plugin/v1` packages.
 *
 * An app's page is a chat session and a description. Each message goes, with
 * the session so far, to the app's own NanoAgent agent, which works through
 * the app's tools and answers; the description is the app's README. What the
 * apps save lands in the caller's own workspace (src/pages/workspace). Both come from NanoAgent, which also owns
 * the agent's model, instructions and the checks on every tool call.
 */

// What the server accepts as history: 24 earlier messages, each 10 000 characters at most.
const HISTORY_LIMIT = 24;
const MESSAGE_LIMIT = 10_000;

function ChatSession({app}) {
  const {useEffect, useRef, useState} = React;
  const {default: API_BASE, apiFetch} = require('@site/src/utils/api');
  const {readEvents, SSE_CONTENT_TYPE} = require('@site/src/utils/eventStream');
  const [turns, setTurns] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const controller = useRef(null);
  const transcript = useRef(null);

  useEffect(() => {
    transcript.current?.scrollTo({top: transcript.current.scrollHeight});
  }, [turns]);
  useEffect(() => () => controller.current?.abort(), []);

  // Every update is to the turn in progress, which is always the last one.
  const updateLast = patch => setTurns(current => [
    ...current.slice(0, -1),
    {...current.at(-1), ...(typeof patch === 'function' ? patch(current.at(-1)) : patch)},
  ]);

  const send = async event => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || running) return;
    // Earlier completed turns are the conversation the agent continues.
    const messages = turns
      .filter(turn => turn.answer && !turn.error)
      .flatMap(turn => [
        {role: 'user', content: turn.prompt.slice(0, MESSAGE_LIMIT)},
        {role: 'assistant', content: turn.answer.slice(0, MESSAGE_LIMIT)},
      ])
      .slice(-HISTORY_LIMIT);
    controller.current = new AbortController();
    setPrompt('');
    setRunning(true);
    setTurns(current => [...current, {prompt: text, answer: '', tools: [], error: null}]);
    let answer = '';
    let closed = false;
    try {
      const res = await apiFetch(`${API_BASE}/api/ai/stream`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({prompt: text, messages, appId: app.id}),
        signal: controller.current.signal,
      });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes(SSE_CONTENT_TYPE)) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Run failed (${res.status})`);
      }
      await readEvents(res, ({event, data}) => {
        if (event === 'delta' && typeof data?.text === 'string') {
          answer += data.text;
          updateLast({answer});
        } else if (event === 'agent' && data?.type?.startsWith('tool.')) {
          const call = {name: data.call?.name ?? 'tool', failed: data.type === 'tool.failed'};
          updateLast(turn => ({tools: [...turn.tools, call]}));
        } else if (event === 'done') {
          closed = true;
          updateLast({answer: data?.text || answer});
        } else if (event === 'error') {
          closed = true;
          updateLast({error: data?.error || 'Run failed'});
        }
      });
      if (!closed) updateLast({error: 'The connection closed before the app finished'});
    } catch (err) {
      updateLast({error: err?.name === 'AbortError' ? 'Stopped' : err.message});
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className={styles.chat}>
      <div className={styles.chatHeader}>
        <strong>Chat with {app.name}</strong>
        <button
          type="button"
          className="button button--link button--sm"
          disabled={running || !turns.length}
          onClick={() => setTurns([])}
        >
          New chat
        </button>
      </div>
      <div ref={transcript} className={styles.transcript}>
        {!turns.length && <p className={styles.muted}>Tell {app.name} what you want done; its agent works through the app's tools.</p>}
        {turns.map((turn, index) => (
          <React.Fragment key={index}>
            <div className={styles.userMessage}>{turn.prompt}</div>
            <div className={styles.agentMessage}>
              {turn.tools.length > 0 && (
                <div className={styles.tools}>
                  {turn.tools.map((call, callIndex) => (
                    <span key={callIndex} className={call.failed ? styles.toolFailed : styles.tool}>
                      {call.failed ? '✕' : '✓'} {call.name}
                    </span>
                  ))}
                </div>
              )}
              {turn.answer && <Markdown text={turn.answer} />}
              {!turn.answer && !turn.error && <span className={styles.muted}>Working…</span>}
              {turn.error && <div className={styles.error}>{turn.error}</div>}
            </div>
          </React.Fragment>
        ))}
      </div>
      <form className={styles.composer} onSubmit={send}>
        <textarea
          rows={2}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
          }}
          placeholder={`Message ${app.name}…  (Enter to send, Shift+Enter for a new line)`}
        />
        {running
          ? <button type="button" className="button button--secondary button--sm" onClick={() => controller.current?.abort()}>Stop</button>
          : <button type="submit" className="button button--primary button--sm" disabled={!prompt.trim()}>Send</button>}
      </form>
    </section>
  );
}

/** A plugin still being built: what it is, and that it cannot be used yet. */
function MaintenanceNotice({app}) {
  return (
    <article className={styles.detail}>
      <header className={styles.detailHeader}>
        <h1>{app.name}</h1>
      </header>
      <section className={styles.maintenanceNotice}>
        <strong>Under maintenance</strong>
        <p>{app.name} is still being built, so it can't be used yet. It will open here once it is ready.</p>
      </section>
    </article>
  );
}

function AppDetail({app}) {
  if (app.status !== 'ready') return <MaintenanceNotice app={app} />;
  const hosts = app.permissions.network.hosts;
  const writes = app.permissions.filesystem.write;
  return (
    <article className={styles.detail}>
      <header className={styles.detailHeader}>
        <h1>{app.name}</h1>
        <div className={styles.badges}>
          <span className={styles.badge}>Network: {hosts.length ? hosts.join(', ') : 'none'}</span>
          <span className={styles.badge}>Writes: {writes.length ? writes.join(', ') : 'none'}</span>
        </div>
      </header>
      <ChatSession app={app} />
      <section className={styles.readme}>
        <h3>About this app</h3>
        <Markdown text={app.readme} />
      </section>
    </article>
  );
}

function AppsColumns() {
  const location = useLocation();
  const {slug, workspace} = useWorkspaceSite();
  const {apps, error} = useWorkspaceApps(workspace);
  const navigation = pluginNavigation(apps ?? [], location.search, `/w/${encodeURIComponent(slug)}/apps`);

  let content = null;
  if (!slug) content = <p className={styles.muted}>Open Plugins from a workspace.</p>;
  else if (error) content = <div className={styles.error}>{error}</div>;
  else if (apps && !apps.length) {
    content = <p className={styles.muted}>NanoAgent publishes no apps. List plugin directories under <code>plugins</code> in its web config.</p>;
  } else if (apps && navigation.unknownGroup) {
    content = <div className={styles.error}>No plugin group named {navigation.unknownGroup}.</div>;
  } else if (apps && navigation.requestedApp && !navigation.app) {
    content = <div className={styles.error}>No app named {navigation.requestedApp}.</div>;
  } else if (apps) {
    content = <AppDetail key={navigation.app.id} app={navigation.app} />;
  }

  return (
    <ThreeColumnLayout
      sidebarKey="plugins"
      showSidebarOnMobile
      renderSidebar={({collapsed, onCollapse}) => (
        <PluginSidebar navigation={navigation} collapsed={collapsed} onCollapse={onCollapse} />
      )}
    >
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary>{content}</ErrorBoundary>}
      </BrowserOnly>
    </ThreeColumnLayout>
  );
}

export default function AppsPage() {
  return (
    <Layout title="Plugins" description="Apps built on NanoAgent">
      <AppsColumns />
    </Layout>
  );
}
