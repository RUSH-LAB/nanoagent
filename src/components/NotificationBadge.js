import React, {useState, useEffect} from 'react';
import API_BASE from '@site/src/utils/api';

const POLL_INTERVAL = 30_000; // 30 seconds
const LS_KEY = 'notificationBadge_lastSeen';
const EPOCH = '1970-01-01T00:00:00.000Z';

const badgeStyle = {
  position: 'absolute',
  top: '-4px',
  right: '-10px',
  background: '#e74c3c',
  color: '#fff',
  fontSize: '10px',
  fontWeight: 700,
  lineHeight: '16px',
  minWidth: '16px',
  height: '16px',
  borderRadius: '8px',
  textAlign: 'center',
  padding: '0 4px',
  boxSizing: 'border-box',
  pointerEvents: 'none',
};

const wrapperStyle = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
};

function getLastSeen() {
  try {
    return localStorage.getItem(LS_KEY) || EPOCH;
  } catch {
    return EPOCH;
  }
}

export function markSeen() {
  try {
    localStorage.setItem(LS_KEY, new Date().toISOString());
  } catch {
    // ignore
  }
}

export default function NotificationBadge({type}) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    async function fetchWithGuard() {
      try {
        const since = getLastSeen();
        const resp = await fetch(
          `${API_BASE}/api/notifications/counts?since=${encodeURIComponent(since)}`,
          {signal: controller.signal},
        );
        if (!resp.ok || !mounted) return;
        const data = await resp.json();
        if (!mounted) return;
        if (type === 'discussions') {
          setCount(data.discussions || 0);
        } else if (type === 'comments') {
          setCount(data.comments || 0);
        } else {
          setCount((data.discussions || 0) + (data.comments || 0));
        }
      } catch {
        // API not available or aborted - hide badge silently
      }
    }

    fetchWithGuard();
    const id = setInterval(fetchWithGuard, POLL_INTERVAL);
    return () => {
      mounted = false;
      controller.abort();
      clearInterval(id);
    };
  }, [type]);

  if (count <= 0) return null;

  return (
    <span style={wrapperStyle}>
      <span style={badgeStyle}>{count > 99 ? '99+' : count}</span>
    </span>
  );
}
