import React, {useCallback, useEffect, useMemo, useState} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {openConversation} from '@site/src/components/CommandBar/openConversation';
import RowMenu from '@site/src/components/RowMenu';
import pageStyles from '@site/src/css/page.module.css';
import dir from '@site/src/css/directory.module.css';
import styles from './styles.module.css';

/**
 * Every channel in the organization, and what can be done to one.
 *
 * The rail beside the CLI is for the conversation you are having; this is for
 * the ones you are not: the public channels you have never joined, the archived
 * ones, and the settings of the channels you administer.
 *
 * Two ways to be allowed to change a channel, matching the server: managing the
 * organization, or having opened the channel yourself. Deleting is neither, and
 * takes managing the organization on its own, because it is the only action
 * here that destroys what other people wrote.
 */

async function call(path, init) {
  const res = await apiFetch(`${API_BASE}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code ?? null;
    throw err;
  }
  return data;
}

/** Why the page has nothing to show, in the words it will say. */
const BLOCKED = {
  401: 'Sign in to see the channels.',
  409: 'You are not in an organization yet.',
};

function dayOf(value) {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? '—'
    : at.toLocaleDateString([], {year: 'numeric', month: 'short', day: 'numeric'});
}

function Channels() {
  const [channels, setChannels] = useState([]);
  const [you, setYou] = useState(null);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // The channel being edited, and the values in the form. One at a time: two
  // open forms is two half-finished renames.
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({name: '', topic: ''});

  const load = useCallback(async () => {
    try {
      // Always asked for with the archived ones. Hiding them behind a second
      // request would mean the toggle could not answer instantly, and there are
      // never many.
      const data = await call('/api/chat/channels?archived=1');
      setChannels(data.channels);
      setYou(data.you);
      setStatus('ready');
    } catch (err) {
      setStatus('blocked');
      setMessage({kind: 'error', text: BLOCKED[err.status] || err.message});
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (channel, run, describe) => {
    setBusyId(channel.id);
    setMessage(null);
    try {
      await run();
      if (describe) setMessage({kind: 'ok', text: describe});
      await load();
    } catch (err) {
      setMessage({kind: 'error', text: err.message});
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const startEdit = (channel) => {
    setEditing(channel.id);
    setDraft({name: channel.name, topic: channel.topic ?? ''});
    setMessage(null);
  };

  const saveEdit = async (e, channel) => {
    e.preventDefault();
    await act(
      channel,
      () => call(`/api/chat/channels/${channel.id}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: draft.name, topic: draft.topic}),
      }),
      `#${channel.name} saved.`,
    );
    setEditing(null);
  };

  const setArchived = (channel, archived) => act(
    channel,
    () => call(`/api/chat/channels/${channel.id}/${archived ? 'archive' : 'unarchive'}`, {method: 'POST'}),
    archived
      ? `#${channel.name} is archived. Nothing more can be said in it, and everything said is still there.`
      : `#${channel.name} is back.`,
  );

  const remove = (channel) => {
    // The only irreversible thing on this page, so it asks for the name rather
    // than for a click: an archive is one keystroke away and does almost the
    // same job.
    const typed = window.prompt(
      `Deleting #${channel.name} deletes every message in it, for everyone, permanently.\n\n` +
      'Archiving keeps them and hides the channel instead.\n\n' +
      `Type the channel name to delete it:`,
    );
    if (typed === null) return;
    if (typed.trim() !== channel.name) {
      setMessage({kind: 'error', text: `That is not "${channel.name}", so nothing was deleted.`});
      return;
    }
    act(channel, () => call(`/api/chat/channels/${channel.id}`, {method: 'DELETE'}), `#${channel.name} is gone.`);
  };

  const join = channel => act(channel, () => call(`/api/chat/channels/${channel.id}/join`, {method: 'POST'}), `You joined #${channel.name}.`);
  const leave = channel => act(channel, () => call(`/api/chat/channels/${channel.id}/leave`, {method: 'POST'}), `You left #${channel.name}.`);

  const open = (channel) => {
    if (!openConversation({channelId: channel.id, label: `#${channel.name}`})) {
      setMessage({kind: 'error', text: 'The command bar is not open on this page.'});
    }
  };

  // A dm is a channel in the schema and nothing like one here: it has no name
  // to rename and nobody administers it. The same list serves the rail, so it
  // is filtered where it is drawn rather than where it is fetched.
  const all = useMemo(() => channels.filter(c => c.kind !== 'dm'), [channels]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter(c => showArchived || !c.archivedAt)
      .filter(c => !q || `${c.name} ${c.topic ?? ''}`.toLowerCase().includes(q));
  }, [all, query, showArchived]);

  const archivedCount = all.filter(c => c.archivedAt).length;

  if (status === 'loading') return <div className={pageStyles.pageContainer}><p>Loading…</p></div>;

  if (status === 'blocked') {
    return (
      <div className={pageStyles.pageContainer}>
        <h1 className={dir.title}>Channels</h1>
        <p className={dir.note}>{message?.text}</p>
      </div>
    );
  }

  const canManage = Boolean(you?.canManage);
  const mayAdminister = channel => canManage || channel.createdBy === you?.userId;

  return (
    <div className={pageStyles.pageContainer}>
      <header className={dir.head}>
        <div>
          <h1 className={dir.title}>Channels</h1>
          <p className={dir.note}>
            {`${shown.length} of ${all.length} ${all.length === 1 ? 'channel' : 'channels'}. `}
            {canManage
              ? 'You can rename, archive, and delete any of them.'
              : 'You can change the ones you opened.'}
          </p>
        </div>
        <input
          className={dir.search}
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Find a channel"
          aria-label="Find a channel"
        />
      </header>

      {archivedCount > 0 && (
        <label className={styles.toggle}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
          {` Show ${archivedCount} archived`}
        </label>
      )}

      {message && (
        <p className={message.kind === 'error' ? dir.error : dir.ok} role="status">{message.text}</p>
      )}

      <ul className={dir.list}>
        {shown.map(channel => (
          <li key={channel.id} className={`${dir.row} ${channel.archivedAt ? styles.archived : ''}`}>
            <span className={styles.mark}>{channel.kind === 'private' ? '*' : '#'}</span>

            {editing === channel.id ? (
              <form className={styles.edit} onSubmit={e => saveEdit(e, channel)}>
                <input
                  className={styles.editName}
                  value={draft.name}
                  onChange={e => setDraft(d => ({...d, name: e.target.value}))}
                  aria-label="Channel name"
                  autoFocus
                />
                <input
                  className={styles.editTopic}
                  value={draft.topic}
                  onChange={e => setDraft(d => ({...d, topic: e.target.value}))}
                  placeholder="What this channel is for"
                  aria-label="Channel topic"
                />
                <button type="submit" className={`${dir.action} ${dir.primary}`} disabled={busyId === channel.id}>Save</button>
                <button type="button" className={dir.action} onClick={() => setEditing(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <span className={dir.identity}>
                  <span className={dir.name}>
                    {channel.name}
                    {channel.kind === 'private' && <span className={dir.tag}>private</span>}
                    {channel.archivedAt && <span className={dir.tag}>archived</span>}
                    {!channel.joined && !channel.archivedAt && <span className={dir.tag}>not joined</span>}
                  </span>
                  <span className={dir.detail}>{channel.topic || 'No topic'}</span>
                </span>

                <span className={dir.meta}>
                  {channel.memberCount} {channel.memberCount === 1 ? 'member' : 'members'}
                  {channel.archivedAt ? ` · archived ${dayOf(channel.archivedAt)}` : ''}
                </span>

                {/* Reading it and being in it stay on the row; renaming,
                    archiving and deleting go behind the menu. Five buttons of
                    equal weight made "Open" and "Delete" look like the same
                    kind of thing. */}
                <span className={dir.actions}>
                  {/* Readable while archived, which is the point of archiving
                      rather than deleting. Posting is what stops. */}
                  <button
                    type="button"
                    className={`${dir.action} ${dir.primary}`}
                    onClick={() => open(channel)}
                  >
                    Open
                  </button>
                  {!channel.archivedAt && (
                    channel.joined
                      ? <button type="button" className={dir.action} disabled={busyId === channel.id} onClick={() => leave(channel)}>Leave</button>
                      : <button type="button" className={dir.action} disabled={busyId === channel.id} onClick={() => join(channel)}>Join</button>
                  )}
                  <RowMenu
                    label={`More for #${channel.name}`}
                    items={[
                      mayAdminister(channel) && !channel.archivedAt && {
                        label: 'Rename, or set a topic',
                        onSelect: () => startEdit(channel),
                      },
                      mayAdminister(channel) && {
                        label: channel.archivedAt ? 'Bring it back' : 'Archive it',
                        disabled: busyId === channel.id,
                        onSelect: () => setArchived(channel, !channel.archivedAt),
                      },
                      canManage && {
                        label: 'Delete it, and its messages',
                        danger: true,
                        disabled: busyId === channel.id,
                        onSelect: () => remove(channel),
                      },
                    ]}
                  />
                </span>
              </>
            )}
          </li>
        ))}
        {shown.length === 0 && (
          <li className={dir.note}>{query ? `No channel matches “${query}”.` : 'No channels yet.'}</li>
        )}
      </ul>
    </div>
  );
}

export default function ChannelsPage() {
  return (
    <Layout title="Channels" description="Every channel in your organization" noFooter>
      <BrowserOnly fallback={<div className={pageStyles.pageContainer}><p>Loading…</p></div>}>
        {() => <Channels />}
      </BrowserOnly>
    </Layout>
  );
}
