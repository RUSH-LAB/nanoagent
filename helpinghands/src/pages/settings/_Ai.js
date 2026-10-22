import React, {useCallback, useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {PaneHeading, Skeleton} from './_parts';
import ApiKeys from './_ApiKeys';
import Servers, {SERVERS} from './_Servers';
import styles from './styles.module.css';
import ai from './ai.module.css';

// How often the pane asks whether RUSH Lab is connected.
const STATUS_MS = 5_000;

// "$0.05", "$0.10", "$0.125": a price to the cent, or the tenth of a cent it has.
const dollars = value => `$${value.toFixed(3).replace(/0$/, '')}`;
const thousands = tokens => (tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`);
// OpenRouter names a model "Maker: Name", and the name already says who made it.
const shortName = label => label.slice(label.indexOf(': ') + 1).trim();
const keyOf = choice => `${choice.provider}/${choice.model}`;

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
 * OpenRouter key (_ApiKeys.js), your own vLLM and SGLang servers
 * (_Servers.js), and the one model chat, inline completion and apps all run
 * on: RUSH's (server/ai-settings.js MODEL), or one your servers serve.
 */
export default function Ai() {
  // {settings, model}: the member's settings, and RUSH's model.
  const [saved, setSaved] = useState(null);
  const [listing, setListing] = useState(null);
  const [computer, setComputer] = useState(null);
  const [error, setError] = useState(null);
  const [choosing, setChoosing] = useState(null);

  useEffect(() => {
    apiRequest('/api/ai/settings')
      .then(setSaved)
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

  // The catalog the member's runs go to, for the model's name and price, and what each of their
  // servers serves; again when RUSH Lab connects or leaves, and when a key or server is saved.
  const connected = Boolean(computer?.connected);
  const loadListing = useCallback(() => apiRequest('/api/ai/models')
    .then(setListing)
    .catch(() => setListing(null)), []);
  useEffect(() => { loadListing(); }, [connected, loadListing]);
  const onSaved = useCallback(() => Promise.all([checkComputer(), loadListing()]), [checkComputer, loadListing]);

  // Save the member's settings with `model` (one of their servers', or null for RUSH's), whole.
  const chooseModel = useCallback(async model => {
    setChoosing({saving: true});
    try {
      const {settings} = await apiRequest('/api/ai/settings', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({settings: {...saved.settings, model}}),
      });
      setSaved(current => ({...current, settings}));
      setChoosing(null);
    } catch (err) {
      setChoosing({error: err.message});
    }
  }, [saved]);
  // A server removed takes the member's model off it, back to RUSH's.
  const onRemoved = useCallback(async engine => {
    if (saved?.settings.model?.provider === engine) await chooseModel(null);
  }, [saved, chooseModel]);

  const heading = <PaneHeading title="Usage" aside={error && <span className={styles.error} role="alert">{error}</span>} />;
  if (!saved) {
    return (
      <>
        {heading}
        {!error && <Skeleton rows={2} />}
      </>
    );
  }
  const own = saved.settings.model;
  const model = own ?? saved.model;
  const known = listing?.models?.find(entry => entry.provider === model.provider && entry.model === model.model);
  const server = own && SERVERS.find(entry => entry.id === own.provider);
  const servedModels = (listing?.models ?? []).filter(entry => SERVERS.some(each => each.id === entry.provider));
  // The member's model, while its server does not serve it: why.
  const missing = own && listing && !known
    ? listing.providers?.find(entry => entry.id === own.provider)?.error ?? `Your ${server?.name ?? own.provider} server does not serve it now.`
    : null;
  return (
    <>
      {heading}
      <section className={styles.group}>
        <ApiKeys computer={computer} onSaved={onSaved} />
      </section>
      <section className={styles.group}>
        <div className={styles.groupHead}>
          <h4 className={styles.groupTitle}>Your servers</h4>
        </div>
        <Servers computer={computer} listing={listing} onSaved={onSaved} onRemoved={onRemoved} />
      </section>
      <section className={styles.group}>
        <div className={styles.groupHead}>
          <h4 className={styles.groupTitle}>Model</h4>
          <select
            className={`${styles.input} ${ai.modelSelect}`}
            value={own ? keyOf(own) : ''}
            disabled={choosing?.saving}
            aria-label="The model chat, inline completion and apps run on"
            onChange={event => {
              const picked = servedModels.find(entry => entry.key === event.target.value);
              chooseModel(picked ? picked.choice : null);
            }}
          >
            <option value="">RUSH's: {shortName((listing?.models?.find(entry => entry.key === keyOf(saved.model)) ?? {label: saved.model.model}).label)}</option>
            {SERVERS.map(each => {
              const models = servedModels.filter(entry => entry.provider === each.id);
              return models.length ? (
                <optgroup key={each.id} label={`Your ${each.name} server`}>
                  {models.map(entry => <option key={entry.key} value={entry.key}>{entry.model}</option>)}
                </optgroup>
              ) : null;
            })}
            {own && !servedModels.some(entry => entry.key === keyOf(own)) && (
              <option value={keyOf(own)} disabled>{own.model} (not served now)</option>
            )}
          </select>
        </div>
        <div className={ai.modelSummary}>
          <strong className={ai.modelName}>{known ? shortName(known.label) : model.model}</strong>
          <code className={ai.modelId}>{model.model}</code>
        </div>
        {(choosing?.error || missing) && (
          <p className={`${ai.modelNote} ${styles.error}`} role="alert">{choosing?.error ?? missing}</p>
        )}
        {known && (
          <dl className={ai.stats}>
            {known.contextWindow && <Stat label="Context window" value={thousands(known.contextWindow)} unit="tokens" />}
            {server ? <Stat label="Served by" value={`Your ${server.name} server`} /> : known.price && (
              <>
                <Stat label="Input" value={dollars(known.price.input)} unit="per 1M tokens" />
                <Stat label="Output" value={dollars(known.price.output)} unit="per 1M tokens" />
              </>
            )}
            {typeof known.reasoning === 'boolean' && <Stat label="Reasoning" value={known.reasoning ? 'Yes' : 'No'} />}
          </dl>
        )}
      </section>
    </>
  );
}
