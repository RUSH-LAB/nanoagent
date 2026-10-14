import React, {useCallback, useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';
import {PaneHeading, Skeleton} from './_parts';
import ApiKeys from './_ApiKeys';
import styles from './styles.module.css';
import ai from './ai.module.css';

// How often the pane asks whether Mochi Lab is connected.
const STATUS_MS = 5_000;
// How often the install command is asked for again: its download token lasts an hour.
const INSTALL_MS = 30 * 60_000;

// "$0.05", "$0.10", "$0.125": a price to the cent, or the tenth of a cent it has.
const dollars = value => `$${value.toFixed(3).replace(/0$/, '')}`;
const thousands = tokens => (tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`);
// OpenRouter names a model "Maker: Name", and the name already says who made it.
const shortName = label => label.slice(label.indexOf(': ') + 1).trim();

/** One thing known of the model, a row of its own. */
function Fact({label, children}) {
  return (
    <div className={`${styles.row} ${ai.fact}`}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{children}</span>
    </div>
  );
}

/**
 * While Mochi Lab is not connected: the line that installs it on the member's
 * Mac, to paste in Terminal (server/routes/lab.js).
 */
function InstallLab() {
  const [command, setCommand] = useState(null);
  const [note, setNote] = useState(null);
  useEffect(() => {
    const load = () => apiRequest('/api/lab/install')
      .then(value => setCommand(value.command))
      .catch(err => setNote({error: err.message}));
    load();
    const timer = setInterval(load, INSTALL_MS);
    return () => clearInterval(timer);
  }, []);
  const copy = () => clientPlatform.clipboard.writeText(command)
    .then(() => setNote({text: 'Copied. Paste it in Terminal.'}))
    .catch(err => setNote({error: err.message}));
  return (
    <section className={styles.group}>
      <div className={styles.groupHead}>
        <h4 className={styles.groupTitle}>Run AI on your Mac</h4>
      </div>
      <div className={`${styles.row} ${ai.installRow}`}>
        <div className={styles.rowLabel}>
          <strong>Paste this in Terminal</strong>
          {note?.error ? <span className={styles.error} role="alert">{note.error}</span>
            : <span role="status">{note?.text ?? 'It installs Mochi Lab to run in the background, then opens a sign-in page.'}</span>}
        </div>
        <div className={styles.rowControl}>
          <button type="button" className={styles.secondaryButton} disabled={!command} onClick={copy}>Copy</button>
        </div>
        <code className={ai.installCommand}>{command ?? '…'}</code>
      </div>
    </section>
  );
}

/**
 * Settings → AI. Your AI runs on your own computer, in Mochi Lab: its
 * OpenRouter key (_ApiKeys.js), and the one model chat, inline completion and
 * apps all run on, which Mochi chooses (server/ai-settings.js MODEL).
 */
export default function Ai() {
  const [model, setModel] = useState(null);
  const [listing, setListing] = useState(null);
  const [computer, setComputer] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiRequest('/api/ai/settings')
      .then(value => setModel(value.model))
      .catch(err => setError(err.message));
  }, []);

  // The member's computer: whether Mochi Lab is connected and which keys it holds, asked again
  // while this pane is open and as soon as a key is saved.
  const checkComputer = useCallback(() => apiRequest('/api/runner/status')
    .then(setComputer)
    .catch(() => setComputer(null)), []);
  useEffect(() => {
    checkComputer();
    const timer = setInterval(checkComputer, STATUS_MS);
    return () => clearInterval(timer);
  }, [checkComputer]);

  // The catalog the member's runs go to, for the model's name and price; again when Mochi Lab
  // connects or leaves, and when a key is saved.
  const connected = Boolean(computer?.connected);
  const loadListing = useCallback(() => apiRequest('/api/ai/models')
    .then(setListing)
    .catch(() => setListing(null)), []);
  useEffect(() => { loadListing(); }, [connected, loadListing]);
  const onSaved = useCallback(() => Promise.all([checkComputer(), loadListing()]), [checkComputer, loadListing]);

  const heading = <PaneHeading title="AI" aside={error && <span className={styles.error} role="alert">{error}</span>} />;
  if (!model) {
    return (
      <>
        {heading}
        {!error && <Skeleton rows={2} />}
      </>
    );
  }
  const known = listing?.models?.find(entry => entry.provider === model.provider && entry.model === model.model);
  return (
    <>
      {heading}
      {computer && !connected && <InstallLab />}
      <section className={styles.group}>
        <ApiKeys computer={computer} onSaved={onSaved} />
      </section>
      <section className={styles.group}>
        <div className={styles.groupHead}>
          <h4 className={styles.groupTitle}>Model</h4>
        </div>
        <Fact label="Name">{known ? shortName(known.label) : model.model}</Fact>
        <Fact label="ID"><code className={ai.modelId}>{model.model}</code></Fact>
        {known?.contextWindow && <Fact label="Context window">{`${thousands(known.contextWindow)} tokens`}</Fact>}
        {known?.price && <Fact label="Input">{`${dollars(known.price.input)} per 1M tokens`}</Fact>}
        {known?.price && <Fact label="Output">{`${dollars(known.price.output)} per 1M tokens`}</Fact>}
        {known && <Fact label="Reasoning">{known.reasoning ? 'Yes' : 'No'}</Fact>}
      </section>
    </>
  );
}
