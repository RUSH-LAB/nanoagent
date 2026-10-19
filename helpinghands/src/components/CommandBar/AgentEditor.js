import React, {useEffect, useState} from 'react';
import {clientPlatform} from '@site/src/platform/client';
import styles from './agentEditor.module.css';

const emptyAgent = () => ({
  name: '',
  description: '',
  instructions: '',
  color: 'violet',
});

const COLORS = ['violet', 'blue', 'emerald', 'amber', 'rose', 'slate'];

/** A workspace agent: a name and instructions. Each member's chats with it run on their own model (Settings → Usage). */
export default function AgentEditor({agent, onSave, onDelete, onClose}) {
  const [draft, setDraft] = useState(emptyAgent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setDraft(agent ? {...agent} : emptyAgent());
    setError(null);
  }, [agent]);

  const update = (key, value) => setDraft(current => ({...current, [key]: value}));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!agent || !(await clientPlatform.dialogs.confirm(`Delete ${agent.name} and its chat history?`))) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(agent.id);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="agent-editor-title">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Workspace agent</span>
            <div id="agent-editor-title" className={styles.title} role="heading" aria-level="2">
              {agent ? 'Edit agent' : 'Create an agent'}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close agent editor">&times;</button>
        </header>

        <form className={styles.form} onSubmit={submit}>
          <label className={styles.label}>
            Name
            <input
              className={styles.input}
              value={draft.name}
              onChange={event => update('name', event.target.value)}
              placeholder="Research partner"
              maxLength={60}
              autoFocus
              required
            />
          </label>

          <label className={styles.label}>
            Short description
            <input
              className={styles.input}
              value={draft.description}
              onChange={event => update('description', event.target.value)}
              placeholder="Finds evidence and challenges assumptions"
              maxLength={180}
            />
          </label>

          <fieldset className={styles.colors}>
            <legend>Color</legend>
            <div className={styles.swatches}>
              {COLORS.map(color => (
                <button
                  key={color}
                  type="button"
                  className={`${styles.swatch} ${styles[`swatch_${color}`]} ${draft.color === color ? styles.swatchOn : ''}`}
                  onClick={() => update('color', color)}
                  aria-label={`${color} agent color`}
                  aria-pressed={draft.color === color}
                />
              ))}
            </div>
          </fieldset>

          <label className={styles.label}>
            Instructions
            <textarea
              className={styles.instructions}
              value={draft.instructions}
              onChange={event => update('instructions', event.target.value)}
              placeholder="Describe this agent's role, tone, expertise, and how it should approach requests."
              maxLength={10000}
              rows={8}
            />
            <span className={styles.help}>
              Optional. Leave blank to use RUSH's default assistant instructions. Which model answers is each member's own choice, in Settings → Usage.
            </span>
          </label>

          {error && <p className={styles.error} role="alert">{error}</p>}

          <footer className={styles.footer}>
            {agent && !agent.builtin && <button type="button" className={styles.delete} onClick={remove} disabled={busy}>Delete</button>}
            <span className={styles.footerSpacer} />
            <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className={styles.primary} disabled={busy}>
              {busy ? 'Saving…' : (agent ? 'Save changes' : 'Create agent')}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
