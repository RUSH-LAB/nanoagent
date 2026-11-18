import React, {useState} from 'react';
import styles from './styles.module.css';

export default function CopyInstructions({subject, text}) {
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setError(null);
      setCopied(text);
    } catch (failure) {
      setCopied(null);
      setError(`Could not copy instructions: ${failure.message}`);
    }
  };
  return (
    <>
      <div className={styles.actionBar}>
        <button type="button" className={styles.secondaryButton} onClick={copy}>Copy {subject} instructions for AI</button>
        {copied === text && <span role="status">Instructions copied</span>}
      </div>
      <details className={styles.advanced}><summary>Read the {subject} instructions</summary><pre>{text}</pre></details>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </>
  );
}
