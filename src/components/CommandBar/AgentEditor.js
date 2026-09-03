import React, {useEffect, useState} from 'react';
import styles from './agentEditor.module.css';

const emptyAgent = defaultProfile => ({
  name: '',
  description: '',
  instructions: '',
  profileId: defaultProfile,
  color: 'violet',
});

const COLORS = ['violet', 'blue', 'emerald', 'amber', 'rose', 'slate'];
const harnessLabel = harness => ({native: 'NanoAgent', hermes: 'Hermes Agent', pi: 'PI'}[harness] ?? harness);

export default function AgentEditor({agent, profileCatalog, onSave, onDelete, onClose}) {
  const profiles = profileCatalog?.profiles ?? [];
  const defaultProfile = profileCatalog?.defaultProfile ?? '';
  const [draft, setDraft] = useState(() => emptyAgent(defaultProfile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setDraft(agent ? {...agent} : emptyAgent(defaultProfile));
    setError(null);
  }, [agent, defaultProfile]);

  const update = (key, value) => setDraft(current => ({...current, [key]: value}));
  const selectedProfile = profiles.find(profile => profile.id === draft.profileId);
  const harnesses = [...new Set(profiles.map(profile => profile.harness))];
  const selectedHarness = selectedProfile?.harness ?? harnesses[0] ?? '';
  const harnessProfiles = profiles.filter(profile => profile.harness === selectedHarness);

  const selectHarness = (harness) => {
    const choices = profiles.filter(profile => profile.harness === harness);
    update('profileId', (choices.find(profile => profile.available) ?? choices[0])?.id ?? '');
  };

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
    if (!agent || !window.confirm(`Delete ${agent.name} and its chat history?`)) return;
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

          <div className={styles.runtimeFields}>
            <label className={styles.label}>
              Agent harness
              <select
                className={styles.input}
                value={selectedHarness}
                onChange={event => selectHarness(event.target.value)}
              >
                {harnesses.map(harness => (
                  <option key={harness} value={harness}>{harnessLabel(harness)}</option>
                ))}
              </select>
            </label>

            <label className={styles.label}>
              Model
              <select
                className={styles.input}
                value={draft.profileId}
                onChange={event => update('profileId', event.target.value)}
              >
                {harnessProfiles.map(profile => (
                  <option key={profile.id} value={profile.id}>
                    {profile.model}{profile.available ? '' : ' (unavailable)'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selectedProfile && !selectedProfile.available && (
            <p className={styles.warning} role="status">
              {selectedProfile.unavailableReason || 'This NanoAgent profile is currently unavailable.'}
            </p>
          )}

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
            <span className={styles.help}>Optional. Leave blank to use Mochi's default assistant instructions.</span>
          </label>

          {error && <p className={styles.error} role="alert">{error}</p>}

          <footer className={styles.footer}>
            {agent && !agent.builtin && <button type="button" className={styles.delete} onClick={remove} disabled={busy}>Delete</button>}
            <span className={styles.footerSpacer} />
            <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className={styles.primary} disabled={busy || !selectedProfile}>
              {busy ? 'Saving…' : (agent ? 'Save changes' : 'Create agent')}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
