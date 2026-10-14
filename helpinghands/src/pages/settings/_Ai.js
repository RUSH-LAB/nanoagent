import React, {useCallback, useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {PaneHeading, Skeleton} from './_parts';
import ApiKeys from './_ApiKeys';
import styles from './styles.module.css';
import ai from './ai.module.css';

// How often the pane asks whether Mochi Lab is connected.
const STATUS_MS = 5_000;

// "$0.05", "$0.10", "$0.125": a price to the cent, or the tenth of a cent it has.
const dollars = value => `$${value.toFixed(3).replace(/0$/, '')}`;
const thousands = tokens => (tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`);
// OpenRouter names a model "Maker: Name", and the name already says who made it.
const shortName = label => label.slice(label.indexOf(': ') + 1).trim();

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
      <section className={styles.group}>
        <ApiKeys computer={computer} onSaved={onSaved} />
        <div className={styles.row}>
          <div className={styles.rowLabel}>
            <strong>Model</strong>
            <span>Chat, inline completion and apps all run on it.</span>
          </div>
          <div className={ai.model}>
            <span className={ai.modelName} title={model.model}>{known ? shortName(known.label) : model.model}</span>
            {known && (
              <span className={ai.modelFacts}>
                {known.contextWindow && <span className={ai.fact}>{`${thousands(known.contextWindow)} context`}</span>}
                {known.price && <span className={ai.fact}>{`${dollars(known.price.input)} / 1M in`}</span>}
                {known.price && <span className={ai.fact}>{`${dollars(known.price.output)} / 1M out`}</span>}
                {known.reasoning && <span className={ai.fact}>Reasoning</span>}
              </span>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
