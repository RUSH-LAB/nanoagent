import React, {useEffect, useState} from 'react';
import styles from './agentEditor.module.css';

export default function ChannelEditor({channel, chat, onClose}) {
  const [draft, setDraft] = useState({name: channel.name, topic: channel.topic ?? ''});
  const [canAdminister, setCanAdminister] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let current = true;
    chat.channelDetails(channel.id)
      .then(details => {
        if (!current) return;
        setCanAdminister(Boolean(details.canAdminister));
        setDraft({name: details.channel.name, topic: details.channel.topic ?? ''});
      })
      .catch(err => {
        if (current) setError(err.message);
      });
    return () => { current = false; };
  }, [chat.channelDetails, channel.id]);

  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (event) => {
    event.preventDefault();
    if (!canAdminister) return;
    setBusy(true);
    setError(null);
    try {
      await chat.update(channel.id, {name: draft.name, topic: draft.topic});
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="channel-editor-title">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Channel settings</span>
            <div id="channel-editor-title" className={styles.title} role="heading" aria-level="2">
              Edit #{channel.name}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close channel settings">&times;</button>
        </header>

        <form className={styles.form} onSubmit={submit}>
          <label className={styles.label}>
            Name
            <input
              className={styles.input}
              value={draft.name}
              onChange={event => setDraft(current => ({...current, name: event.target.value}))}
              maxLength={80}
              autoFocus
              required
            />
          </label>

          <label className={styles.label}>
            Topic
            <input
              className={styles.input}
              value={draft.topic}
              onChange={event => setDraft(current => ({...current, topic: event.target.value}))}
              placeholder="What this channel is for"
              maxLength={500}
            />
          </label>

          {canAdminister === false && (
            <p className={styles.error} role="alert">
              Only the channel creator or workspace owner can change these settings.
            </p>
          )}
          {error && <p className={styles.error} role="alert">{error}</p>}

          <footer className={styles.footer}>
            <span className={styles.footerSpacer} />
            <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className={styles.primary} disabled={busy || !canAdminister || !draft.name.trim()}>
              {busy ? 'Saving…' : (canAdminister === null ? 'Loading…' : 'Save changes')}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
