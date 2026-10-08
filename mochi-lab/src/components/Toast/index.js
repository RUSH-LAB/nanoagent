import React, {useState, useEffect, useCallback} from 'react';
import {subscribe, getToasts, toast} from './toast';
import styles from './styles.module.css';

const ICONS = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ⓘ',
};

function ToastItem({item}) {
  const [exiting, setExiting] = useState(false);

  const handleClose = useCallback(() => {
    setExiting(true);
    setTimeout(() => toast.dismiss(item.id), 200);
  }, [item.id]);

  const typeClass = styles[item.type] || '';

  return (
    <div
      className={`${styles.toast} ${typeClass} ${exiting ? styles.exiting : ''}`}
      role="alert"
    >
      <span className={styles.icon}>{ICONS[item.type] || ICONS.info}</span>
      <span className={styles.message}>{item.message}</span>
      {item.action && item.actionLabel && (
        <button
          className={styles.actionBtn}
          onClick={() => { item.action(); handleClose(); }}
        >
          {item.actionLabel}
        </button>
      )}
      <button
        className={styles.closeBtn}
        onClick={handleClose}
        aria-label="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}

export default function ToastContainer() {
  const [items, setItems] = useState(getToasts);

  useEffect(() => {
    return subscribe(setItems);
  }, []);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className={styles.container} aria-live="polite">
      {items.map((item) => (
        <ToastItem key={item.id} item={item} />
      ))}
    </div>
  );
}
