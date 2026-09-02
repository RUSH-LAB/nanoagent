import React from 'react';
import styles from './documentEditor.module.css';

export default function DocumentEditAction({onEdit}) {
  if (!onEdit) return null;
  return (
    <div className={styles.editAction}>
      <button type="button" onClick={onEdit}>Edit</button>
    </div>
  );
}
