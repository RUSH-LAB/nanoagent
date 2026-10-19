import React, {useCallback, useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {PaneHeading, Skeleton} from './_parts';
import ApiKeys from './_ApiKeys';
import styles from './styles.module.css';
import ai from './ai.module.css';

// How often the pane asks whether RUSH Lab is connected.
const STATUS_MS = 5_000;

// "$0.05", "$0.10", "$0.125": a price to the cent, or the tenth of a cent it has.
const dollars = value => `$${value.toFixed(3).replace(/0$/, '')}`;
const thousands = tokens => (tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`);
// OpenRouter names a model "Maker: Name", and the name already says who made it.
const shortName = label => label.slice(label.indexOf(': ') + 1).trim();

/** One figure of the model's, as a tile: its name, the figure large, and its unit. */
function Stat({label, value, unit}) {
  return (
    <div className={ai.stat}>
      <dt>{label}</dt>
      <dd><span className={ai.statValue}>{value}</span>{unit && <span className={ai.statUnit}>{unit}</span>}</dd>
    </div>
  );
}

/**
 * Settings → AI. Your AI runs on your own computer, in RUSH Lab: its
 * OpenRouter key (_ApiKeys.js), and the one model chat, inline completion and
 * apps all run on, which RUSH chooses (server/ai-settings.js MODEL).
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

  // The member's computer: whether RUSH Lab is connected and which keys it holds, asked again
  // while this pane is open and as soon as a key is saved.
  const checkComputer = useCallback(() => apiRequest('/api/runner/status')
    .then(setComputer)
    .catch(() => setComputer(null)), []);
  useEffect(() => {
    checkComputer();
    const timer = setInterval(checkComputer, STATUS_MS);
    return () => clearInterval(timer);
  }, [checkComputer]);

  // The catalog the member's runs go to, for the model's name and price; again when RUSH Lab
  // connects or leaves, and when a key is saved.
  const connected = Boolean(computer?.connected);
  const loadListing = useCallback(() => apiRequest('/api/ai/models')
    .then(setListing)
    .catch(() => setListing(null)), []);
  useEffect(() => { loadListing(); }, [connected, loadListing]);
  const onSaved = useCallback(() => Promise.all([checkComputer(), loadListing()]), [checkComputer, loadListing]);

  const heading = <PaneHeading title="Usage" aside={error && <span className={styles.error} role="alert">{error}</span>} />;
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
      <section className={styles.group}>
        <ApiKeys computer={computer} onSaved={onSaved} />
      </section>
      <section className={styles.group}>
        <div className={styles.groupHead}>
          <h4 className={styles.groupTitle}>Model</h4>
        </div>
        <div className={ai.modelSummary}>
          <strong className={ai.modelName}>{known ? shortName(known.label) : model.model}</strong>
          <code className={ai.modelId}>{model.model}</code>
        </div>
        {known && (
          <dl className={ai.stats}>
            {known.contextWindow && <Stat label="Context window" value={thousands(known.contextWindow)} unit="tokens" />}
            {known.price && <Stat label="Input" value={dollars(known.price.input)} unit="per 1M tokens" />}
            {known.price && <Stat label="Output" value={dollars(known.price.output)} unit="per 1M tokens" />}
            <Stat label="Reasoning" value={known.reasoning ? 'Yes' : 'No'} />
          </dl>
        )}
      </section>
    </>
  );
}
