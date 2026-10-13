import React, {useMemo, useRef, useState} from 'react';
import {usePopover} from '@site/src/hooks/usePopover';
import {fuzzyMatch} from '@site/src/utils/fuzzyMatch';
import menu from '@site/src/css/menu.module.css';
import styles from './ai.module.css';

// Roughly the tallest the list gets, in pixels.
const MENU_ROOM = 420;
// Rows drawn at once; a search narrows the rest.
const SHOWN = 120;

const thousands = tokens => (tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`);
const dollars = value => `$${Number(value.toFixed(3))}`;

/** What is known of a model: its context, its price per million tokens, and whether it reasons. */
export function modelFacts(model) {
  return [
    model.contextWindow ? `${thousands(model.contextWindow)} context` : null,
    model.price?.input != null ? `${dollars(model.price.input)} in · ${dollars(model.price.output)} out per 1M` : null,
    model.reasoning ? 'reasoning' : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Picks the model one use runs on (Settings → AI): every model on the
 * member's computer, grouped by provider and searchable by name,
 * id or provider. The first row returns the use to NanoAgent's default.
 * A model whose provider has no key is listed, but cannot be picked.
 */
export default function ModelPicker({models, use, value, defaultKey, onChange, disabled, label}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  const popover = usePopover(MENU_ROOM, () => searchRef.current?.focus());
  const choices = useMemo(() => models.filter(model => model.uses.includes(use)), [models, use]);
  const byKey = key => choices.find(model => model.key === key);
  const current = value ? byKey(value) : null;
  const fallback = byKey(defaultKey);
  // What the use runs on now; one whose provider has no key says which key it needs.
  const running = current ?? (!value ? fallback : null);

  const shown = useMemo(() => {
    const scored = choices
      .map(model => ({model, match: fuzzyMatch(query, `${model.label} ${model.model} ${model.providerName ?? model.provider ?? ''}`)}))
      .filter(entry => entry.match.match);
    // Usable first, then the best match; equal scores keep the catalog's order.
    scored.sort((a, b) => Number(b.model.available) - Number(a.model.available) || b.match.score - a.match.score);
    return scored.map(entry => entry.model);
  }, [choices, query]);

  const choose = model => {
    popover.close({toTrigger: true});
    setQuery('');
    onChange(model ? model.choice : null);
  };

  let group = null;
  return (
    <span className={styles.picker} ref={popover.wrapRef} onKeyDown={popover.onKeyDown}>
      <button
        type="button"
        ref={popover.triggerRef}
        className={styles.pickerButton}
        disabled={disabled}
        onClick={popover.toggle}
        aria-haspopup="listbox"
        aria-expanded={popover.open}
        aria-label={label}
      >
        <span className={styles.pickerValue}>
          {current ? current.label : value ? value : `Default${fallback ? ` · ${fallback.label}` : ''}`}
        </span>
        <span className={`${styles.pickerProvider} ${running && !running.available ? styles.pickerMissing : ''}`}>
          {running && !running.available ? running.unavailableReason : running?.providerName ?? running?.provider ?? ''}
        </span>
      </button>

      {popover.open && (
        <span className={`${menu.menu} ${styles.pickerMenu} ${popover.above ? menu.above : ''}`}>
          <input
            ref={searchRef}
            className={styles.search}
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={`Search ${choices.length} models`}
            aria-label="Search models"
          />
          <span className={styles.pickerList} role="listbox" aria-label={label}>
            {!query && (
              <button type="button" role="option" aria-selected={!value} className={`${menu.item} ${styles.pickerItem}`} onClick={() => choose(null)}>
                <span className={styles.pickerName}>Default</span>
                <span className={styles.pickerNote}>{fallback ? `NanoAgent's choice: ${fallback.label}` : 'NanoAgent\'s choice'}</span>
              </button>
            )}
            {shown.slice(0, SHOWN).map(model => {
              const heading = model.providerName ?? model.provider ?? 'NanoAgent';
              const head = !query && heading !== group ? <span className={styles.pickerGroup} key={`group-${heading}`}>{heading}</span> : null;
              group = heading;
              return (
                <React.Fragment key={model.key}>
                  {head}
                  <button
                    type="button"
                    role="option"
                    aria-selected={model.key === value}
                    disabled={!model.available}
                    title={model.unavailableReason ?? undefined}
                    className={`${menu.item} ${styles.pickerItem}`}
                    onClick={() => choose(model)}
                  >
                    <span className={styles.pickerName}>{model.label}</span>
                    <span className={styles.pickerNote}>
                      {model.available ? modelFacts(model) || model.model : model.unavailableReason}
                    </span>
                  </button>
                </React.Fragment>
              );
            })}
            {shown.length > SHOWN && <span className={styles.pickerMore}>{shown.length - SHOWN} more: refine the search</span>}
            {!shown.length && <span className={styles.pickerMore}>No model matches</span>}
          </span>
        </span>
      )}
    </span>
  );
}
