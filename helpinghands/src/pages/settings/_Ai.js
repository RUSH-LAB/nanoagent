import React, {useCallback, useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {PaneHeading, Skeleton} from './_parts';
import ApiKeys from './_ApiKeys';
import styles from './styles.module.css';
import ai from './ai.module.css';

// How often the pane asks whether Mochi Lab is connected.
const STATUS_MS = 5_000;

const dollars = value => `$${Number(value.toFixed(3))}`;

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

  // The computer's catalog, for the model's name and price; again when Mochi Lab connects or leaves.
  const connected = Boolean(computer?.connected);
  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/ai/models')
      .then(value => { if (!cancelled) setListing(value); })
      .catch(() => { if (!cancelled) setListing(null); });
    return () => { cancelled = true; };
  }, [connected]);

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
        <ApiKeys computer={computer} onSaved={checkComputer} />
        <div className={styles.row}>
          <div className={styles.rowLabel}>
            <strong>Model</strong>
            <span>
              {known?.price
                ? `${dollars(known.price.input)} in · ${dollars(known.price.output)} out per million tokens`
                : 'Its price shows once Mochi Lab is connected.'}
            </span>
          </div>
          <span className={ai.model}>{known?.label ?? model.model}</span>
        </div>
      </section>
    </>
  );
}
