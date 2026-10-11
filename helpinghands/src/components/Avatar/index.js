import React from 'react';
import styles from './styles.module.css';

/** "Ada Lovelace" → "AL", "ada" → "A"; from the name, else the username or email. */
export function initialsOf(user) {
  const words = String(user?.name || user?.username || user?.email?.split('@')[0] || '')
    .trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0][0];
  return letters.toUpperCase();
}

/** The user's picture (`user.image`), or their initials in a circle when they have none. */
export default function Avatar({user, size = 30}) {
  const style = {width: size, height: size, fontSize: size * 0.4};
  if (user?.image) {
    return <img className={styles.avatar} style={style} src={user.image} alt="" aria-hidden="true" />;
  }
  return <span className={styles.avatar} style={style} aria-hidden="true">{initialsOf(user)}</span>;
}
