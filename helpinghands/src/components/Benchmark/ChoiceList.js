import React, {useId, useState} from 'react';
import styles from './styles.module.css';

export default function ChoiceList({label, description, options, value, onChange, searchPlaceholder, disabled = false}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();
  const visible = options.filter(item => item.value === value || !search ||
    [item.label, item.value, item.detail].some(text => typeof text === 'string' && text.toLowerCase().includes(search)));

  return (
    <fieldset className={styles.choices} disabled={disabled} aria-describedby={description ? `${id}-hint` : undefined}>
      <legend>{label}</legend>
      {description && <p id={`${id}-hint`} className={styles.fieldHint}>{description}</p>}
      {searchPlaceholder && options.length > 4 && (
        <input type="search" value={query} onChange={event => setQuery(event.target.value)}
          className={styles.searchInput} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
      )}
      {visible.length > 0 ? (
        <div className={styles.choiceGrid}>
          {visible.map(item => (
            <label key={item.value} className={styles.choice}>
              <input type="radio" name={id} checked={item.value === value} onChange={() => onChange(item.value)} />
              <span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>
            </label>
          ))}
        </div>
      ) : <p className={styles.fieldHint}>{search ? 'No matches.' : 'No options available.'}</p>}
    </fieldset>
  );
}
