import { useEffect, useRef } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import API_BASE from '@site/src/utils/api';

function PageTrackerInner() {
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;

    const pagePath = window.location.pathname;
    const referrer = document.referrer || undefined;
    const userAgent = navigator.userAgent || undefined;

    fetch(`${API_BASE}/api/analytics/pageview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pagePath, referrer, userAgent }),
    }).catch(() => {
      // fire-and-forget: silently ignore errors
    });
  }, []);

  return null;
}

export default function PageTracker() {
  return (
    <BrowserOnly>
      {() => <PageTrackerInner />}
    </BrowserOnly>
  );
}
