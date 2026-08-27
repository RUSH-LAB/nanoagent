import React from 'react';
import styles from './styles.module.css';

// Generate a consistent color from a user name string
function nameToColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  // Pick from a set of distinct, readable colors
  const colors = [
    '#e74c3c', '#3498db', '#2ecc71', '#9b59b6',
    '#e67e22', '#1abc9c', '#e84393', '#0984e3',
    '#6c5ce7', '#00b894', '#fd79a8', '#fdcb6e',
  ];
  return colors[Math.abs(hash) % colors.length];
}

// Get initials from a name (up to 2 characters)
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return parts[0][0] + parts[1][0];
  }
  return name.slice(0, 2);
}

export default function PresenceIndicator({users}) {
  if (!users || users.length === 0) return null;

  return (
    <div className={styles.presenceContainer}>
      {users.map((user) => (
        <div
          key={user.userId}
          className={styles.presenceDot}
          style={{backgroundColor: nameToColor(user.userName)}}
        >
          {getInitials(user.userName)}
          <span className={styles.tooltip}>{user.userName}</span>
        </div>
      ))}
    </div>
  );
}
