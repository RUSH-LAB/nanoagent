import React, {useState, useEffect, useCallback, useRef} from 'react';
import styles from './styles.module.css';
import API_BASE from '@site/src/utils/api';

const EMOJI_MAP = {
  thumbsup: '\u{1F44D}',
  heart: '❤️',
  laugh: '\u{1F604}',
  thinking: '\u{1F914}',
  celebrate: '\u{1F389}',
};

const EMOJI_KEYS = Object.keys(EMOJI_MAP);

function getUserId() {
  let id = typeof localStorage !== 'undefined' && localStorage.getItem('comment_user_id');
  if (!id) {
    id = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (typeof localStorage !== 'undefined') localStorage.setItem('comment_user_id', id);
  }
  return id;
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
}

// ── Reaction bar under each comment ─────────────────────────────────────

function ReactionBar({reactions = [], pageId, commentId, onReactionsChanged}) {
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef(null);
  const userId = getUserId();

  // Close picker on outside click
  useEffect(() => {
    if (!showPicker) return;
    function handleClick(e) {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setShowPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPicker]);

  const toggleReaction = async (emoji) => {
    const hasReacted = reactions.some(r => r.emoji === emoji && r.userId === userId);
    const method = hasReacted ? 'DELETE' : 'POST';
    try {
      const res = await fetch(`${API_BASE}/api/comments/react`, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({page: pageId, commentId, emoji, userId}),
      });
      if (res.ok) {
        const data = await res.json();
        onReactionsChanged?.(commentId, data.reactions);
      }
    } catch {
      // silently fail
    }
    setShowPicker(false);
  };

  // Group reactions by emoji
  const grouped = {};
  for (const r of reactions) {
    if (!grouped[r.emoji]) grouped[r.emoji] = [];
    grouped[r.emoji].push(r.userId);
  }

  return (
    <div className={styles.reactionBar}>
      {EMOJI_KEYS.map((key) => {
        const users = grouped[key];
        if (!users || users.length === 0) return null;
        const isMine = users.includes(userId);
        return (
          <button
            key={key}
            className={`${styles.reactionChip} ${isMine ? styles.reactionChipActive : ''}`}
            onClick={() => toggleReaction(key)}
            type="button"
            title={`${EMOJI_MAP[key]} ${users.length}`}
          >
            {EMOJI_MAP[key]} {users.length}
          </button>
        );
      })}
      <div className={styles.reactionPickerWrap} ref={pickerRef}>
        <button
          className={styles.reactionAddBtn}
          onClick={() => setShowPicker(v => !v)}
          type="button"
          title="Add reaction"
          aria-label="Add reaction"
        >
          +
        </button>
        {showPicker && (
          <div className={styles.reactionPicker}>
            {EMOJI_KEYS.map((key) => (
              <button
                key={key}
                className={styles.reactionOption}
                onClick={() => toggleReaction(key)}
                type="button"
                title={key}
              >
                {EMOJI_MAP[key]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Comment form (used for top-level and inline reply) ────────────────────

function getStoredName() {
  try { return localStorage.getItem('mochi_comment_name') || ''; } catch { return ''; }
}

function CommentForm({pageId, parentId, onPosted, inline}) {
  const [author, setAuthor] = useState(() => getStoredName());
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const body = {
        page: pageId,
        author: author.trim() || 'Anonymous',
        text: text.trim(),
        userId: getUserId(),
      };
      if (parentId) body.parentId = parentId;

      const res = await fetch(`${API_BASE}/api/comments`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`Server error (${res.status})`);

      try { if (author.trim()) localStorage.setItem('mochi_comment_name', author.trim()); } catch {}
      setText('');
      onPosted?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={`${styles.form} ${inline ? styles.formInline : ''}`}
      onSubmit={handleSubmit}
    >
      <div className={styles.inputRow}>
        <input
          className={styles.authorInput}
          type="text"
          placeholder="Name (optional)"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          disabled={submitting}
        />
        <input
          className={styles.textInput}
          type="text"
          placeholder="Add a comment..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={submitting}
          required
        />
        <button
          className={styles.submitBtn}
          type="submit"
          disabled={submitting || !text.trim()}
        >
          {submitting ? 'Posting...' : 'Post'}
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </form>
  );
}

// ── Single comment with optional threaded replies ─────────────────────────

function Comment({comment, replies, pageId, onPosted, onDeleted, onReactionsChanged}) {
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handlePosted = () => {
    setShowReplyForm(false);
    onPosted?.();
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this comment?')) return;
    setDeleting(true);
    try {
      await fetch(`${API_BASE}/api/comments`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({page: pageId, commentId: comment.id, userId: getUserId()}),
      });
      onDeleted?.(comment.id);
    } catch {
      // Server endpoint may not exist yet; still remove locally
      onDeleted?.(comment.id);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <li className={styles.comment}>
      <div className={styles.commentHeader}>
        <span className={styles.author}>{comment.author}</span>
        <span className={styles.timestamp}>{formatTime(comment.createdAt)}</span>
        <button
          className={styles.deleteBtn}
          onClick={handleDelete}
          disabled={deleting}
          type="button"
          title="Delete comment"
          aria-label="Delete comment"
        >
          &times;
        </button>
      </div>
      <p className={styles.commentText}>{comment.text}</p>
      <ReactionBar
        reactions={comment.reactions || []}
        pageId={pageId}
        commentId={comment.id}
        onReactionsChanged={onReactionsChanged}
      />
      <button
        className={styles.replyToggle}
        onClick={() => setShowReplyForm((v) => !v)}
        type="button"
        aria-label={showReplyForm ? 'Cancel reply' : `Reply to ${comment.author}`}
      >
        {showReplyForm ? 'Cancel' : 'Reply'}
      </button>

      {showReplyForm && (
        <CommentForm
          pageId={pageId}
          parentId={comment.id}
          onPosted={handlePosted}
          inline
        />
      )}

      {replies.length > 0 && (
        <ul className={styles.replies}>
          {replies.map((r) => (
            <Comment
              key={r.id}
              comment={r}
              replies={[]}
              pageId={pageId}
              onPosted={onPosted}
              onDeleted={onDeleted}
              onReactionsChanged={onReactionsChanged}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ── Main Comments component ───────────────────────────────────────────────

export default function Comments({pageId}) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchComments = useCallback(async () => {
    if (!pageId) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/comments?page=${encodeURIComponent(pageId)}`,
      );
      if (!res.ok) throw new Error(`Failed to load comments (${res.status})`);
      const data = await res.json();
      setComments(data.comments ?? []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  useEffect(() => {
    setLoading(true);
    fetchComments();
  }, [fetchComments]);

  const handleDelete = useCallback((commentId) => {
    setComments((prev) => prev.filter((c) => c.id !== commentId));
  }, []);

  const handleReactionsChanged = useCallback((commentId, newReactions) => {
    setComments((prev) =>
      prev.map((c) => (c.id === commentId ? {...c, reactions: newReactions} : c)),
    );
  }, []);

  // Build thread structure: top-level comments + grouped replies
  const topLevel = comments.filter((c) => !c.parentId);
  const repliesByParent = {};
  for (const c of comments) {
    if (c.parentId) {
      if (!repliesByParent[c.parentId]) repliesByParent[c.parentId] = [];
      repliesByParent[c.parentId].push(c);
    }
  }

  return (
    <section className={styles.commentsSection} aria-label="Comments section">
      <h3 className={styles.heading}>Comments</h3>

      {loading && <p className={styles.loading}>Loading comments...</p>}
      {error && <p className={styles.error}>{error}</p>}

      {!loading && !error && topLevel.length === 0 && (
        <p className={styles.empty}>No comments yet. Be the first!</p>
      )}

      {topLevel.length > 0 && (
        <ul className={styles.commentList} role="list" aria-label="Comment threads">
          {topLevel.map((c) => (
            <Comment
              key={c.id}
              comment={c}
              replies={repliesByParent[c.id] ?? []}
              pageId={pageId}
              onPosted={fetchComments}
              onDeleted={handleDelete}
              onReactionsChanged={handleReactionsChanged}
            />
          ))}
        </ul>
      )}

      <CommentForm pageId={pageId} onPosted={fetchComments} />
    </section>
  );
}
