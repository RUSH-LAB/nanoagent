import React, {useState, useEffect} from 'react';
import API_BASE from '../../utils/api';

export default function BookmarkButton({pagePath, pageTitle}) {
  const [bookmarked, setBookmarked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/bookmarks`)
      .then(r => r.json())
      .then(data => {
        const exists = (data.bookmarks || []).some(b => b.path === pagePath);
        setBookmarked(exists);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pagePath]);

  async function toggle() {
    if (loading) return;
    setLoading(true);
    try {
      if (bookmarked) {
        await fetch(`${API_BASE}/api/bookmarks`, {
          method: 'DELETE',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: pagePath}),
        });
        setBookmarked(false);
      } else {
        await fetch(`${API_BASE}/api/bookmarks`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: pagePath, title: pageTitle || pagePath}),
        });
        setBookmarked(true);
      }
    } catch (err) {
      console.error('Bookmark toggle failed:', err);
    } finally {
      setLoading(false);
    }
  }

  const starStyle = {
    background: 'none',
    border: 'none',
    cursor: loading ? 'default' : 'pointer',
    fontSize: '1.3rem',
    padding: '4px 6px',
    lineHeight: 1,
    opacity: loading ? 0.4 : 1,
    transition: 'opacity 0.2s',
    title: bookmarked ? 'Remove bookmark' : 'Add bookmark',
  };

  return (
    <button
      onClick={toggle}
      disabled={loading}
      style={starStyle}
      aria-label={bookmarked ? 'Remove bookmark' : 'Add bookmark'}
      title={bookmarked ? 'Remove bookmark' : 'Add bookmark'}
    >
      {bookmarked ? '★' : '☆'}
    </button>
  );
}
