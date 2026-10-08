import React, {useEffect, useState} from 'react';
import {clientPlatform} from '@site/src/platform/client';
import styles from './agentEditor.module.css';

const ROLES = ['owner', 'editor', 'viewer'];
const labelOf = person => person.username || person.name || person.email || 'Person';

export default function PersonEditor({person, chat, onClose}) {
  const [role, setRole] = useState(person.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const canManage = Boolean(chat.you?.canManage && !person.you);

  useEffect(() => {
    setRole(person.role);
    setError(null);
  }, [person]);

  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (event) => {
    event.preventDefault();
    if (!canManage) return;
    setBusy(true);
    setError(null);
    try {
      await chat.updateWorkspaceMember(person.memberId, role);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!canManage) return;
    if (!clientPlatform.dialogs.confirm(`Remove ${labelOf(person)} from this workspace?`)) return;
    setBusy(true);
    setError(null);
    try {
      await chat.removeWorkspaceMember(person.memberId);
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
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="person-editor-title">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Person settings</span>
            <div id="person-editor-title" className={styles.title} role="heading" aria-level="2">
              {labelOf(person)}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close person settings">&times;</button>
        </header>

        <form className={styles.form} onSubmit={submit}>
          {person.email && <span className={styles.help}>{person.email}</span>}
          <label className={styles.label}>
            Workspace role
            <select className={styles.input} value={role} onChange={event => setRole(event.target.value)} autoFocus disabled={!canManage}>
              {ROLES.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>

          {!canManage && (
            <p className={styles.help} role="status">
              {person.you
                ? 'Your own workspace membership cannot be changed here.'
                : 'Only a workspace owner can change this person.'}
            </p>
          )}
          {error && <p className={styles.error} role="alert">{error}</p>}

          <footer className={styles.footer}>
            {canManage && <button type="button" className={styles.delete} onClick={remove} disabled={busy}>Remove</button>}
            <span className={styles.footerSpacer} />
            <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>Cancel</button>
            {canManage && (
              <button type="submit" className={styles.primary} disabled={busy || role === person.role}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            )}
          </footer>
        </form>
      </section>
    </div>
  );
}
