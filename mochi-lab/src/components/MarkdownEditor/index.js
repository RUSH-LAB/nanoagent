import React from 'react';
import styles from './styles.module.css';

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

export function EditablePageWrapper({source, children}) {
  if (process.env.NODE_ENV !== 'development' || !source) {
    return <>{children}</>;
  }

  return (
    <div style={{position: 'relative'}}>
      <a
        className={styles.editButton}
        href={`/editor?file=${encodeURIComponent(source)}`}
        title="Edit this page"
      >
        <PencilIcon /> Edit
      </a>
      {children}
    </div>
  );
}
