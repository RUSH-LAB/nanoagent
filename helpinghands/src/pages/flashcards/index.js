import React, {useState, useEffect, useCallback} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import pageStyles from '@site/src/css/page.module.css';
import {clientPlatform} from '@site/src/platform/client';

const MODES = {browse: 'Browse', create: 'Create', review: 'Review'};

function FlashcardsApp() {
  const { default: API_BASE, apiFetch } = require('@site/src/utils/api');

  const [mode, setMode] = useState('browse');
  const [cards, setCards] = useState([]);
  const [dueCount, setDueCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Create form
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [source, setSource] = useState('');
  const [creating, setCreating] = useState(false);

  // Review state
  const [reviewCards, setReviewCards] = useState([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewDone, setReviewDone] = useState(false);
  const [sessionReviewed, setSessionReviewed] = useState(0);

  // Filter
  const [filterTag, setFilterTag] = useState('');

  const fetchCards = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/flashcards`);
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setCards(data.cards || []);
      setDueCount(data.due || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCards(); }, [fetchCards]);

  const fetchReviewCards = useCallback(async () => {
    setReviewLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/flashcards/review`);
      if (!res.ok) throw new Error(`Failed to load review cards (${res.status})`);
      const data = await res.json();
      setReviewCards(data.cards || []);
      setReviewIndex(0);
      setFlipped(false);
      setReviewDone(data.cards.length === 0);
      setSessionReviewed(0);
    } catch (err) {
      setError(err.message);
    } finally {
      setReviewLoading(false);
    }
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!front.trim() || !back.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
      const res = await apiFetch(`${API_BASE}/api/flashcards`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({front: front.trim(), back: back.trim(), tags, source: source.trim() || undefined}),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      setFront('');
      setBack('');
      setTagsInput('');
      setSource('');
      await fetchCards();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id) => {
    if (!(await clientPlatform.dialogs.confirm('Delete this flashcard?'))) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/flashcards`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id}),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      await fetchCards();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleReview = async (quality) => {
    const card = reviewCards[reviewIndex];
    if (!card) return;
    setReviewLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/flashcards/review`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: card.id, quality}),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      setSessionReviewed(s => s + 1);
      if (reviewIndex + 1 < reviewCards.length) {
        setReviewIndex(reviewIndex + 1);
        setFlipped(false);
      } else {
        setReviewDone(true);
        await fetchCards();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setReviewLoading(false);
    }
  };

  const startReview = () => {
    setMode('review');
    fetchReviewCards();
  };

  // Collect all tags for filter
  const allTags = [...new Set(cards.flatMap(c => c.tags || []))].sort();
  const filteredCards = filterTag
    ? cards.filter(c => c.tags && c.tags.includes(filterTag))
    : cards;

  // Stats
  const totalCards = cards.length;
  const reviewedToday = cards.filter(c => {
    if (!c.lastReview) return false;
    const d = new Date(c.lastReview);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  if (loading) {
    return (
      <div style={{textAlign: 'center', padding: '4rem', color: 'var(--ifm-color-emphasis-500)'}}>
        Loading flashcards...
      </div>
    );
  }

  return (
    <div className={pageStyles.pageContainer} role="main" aria-label="Flashcards application">
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '1.5rem', flexWrap: 'wrap', gap: '12px',
      }}>
        <div>
          <h1 style={{margin: 0, fontSize: '1.8em'}}>Flashcards</h1>
          <p style={{margin: '4px 0 0', color: 'var(--ifm-color-emphasis-600)', fontSize: '0.9em'}}>
            Spaced repetition study cards from your notes.
          </p>
        </div>
      </div>

      {/* Stats bar */}
      <div style={{
        display: 'flex', gap: 16, marginBottom: '1.5rem', flexWrap: 'wrap',
      }} role="region" aria-label="Study statistics">
        <div style={{
          padding: '12px 20px', borderRadius: 10,
          background: 'var(--ifm-color-emphasis-100)',
          textAlign: 'center', minWidth: 100,
        }}>
          <div style={{fontSize: '1.5em', fontWeight: 700, color: 'var(--ifm-color-primary)'}}>{totalCards}</div>
          <div style={{fontSize: '0.8em', color: 'var(--ifm-color-emphasis-600)'}}>Total Cards</div>
        </div>
        <div style={{
          padding: '12px 20px', borderRadius: 10,
          background: dueCount > 0 ? 'var(--ifm-color-warning-contrast-background)' : 'var(--ifm-color-emphasis-100)',
          textAlign: 'center', minWidth: 100,
          border: dueCount > 0 ? '1px solid var(--ifm-color-warning-dark)' : 'none',
        }}>
          <div style={{fontSize: '1.5em', fontWeight: 700, color: dueCount > 0 ? 'var(--ifm-color-warning-dark)' : 'var(--ifm-color-emphasis-600)'}}>{dueCount}</div>
          <div style={{fontSize: '0.8em', color: 'var(--ifm-color-emphasis-600)'}}>Due Today</div>
        </div>
        <div style={{
          padding: '12px 20px', borderRadius: 10,
          background: 'var(--ifm-color-emphasis-100)',
          textAlign: 'center', minWidth: 100,
        }}>
          <div style={{fontSize: '1.5em', fontWeight: 700, color: 'var(--ifm-color-success-dark)'}}>{reviewedToday}</div>
          <div style={{fontSize: '0.8em', color: 'var(--ifm-color-emphasis-600)'}}>Reviewed Today</div>
        </div>
      </div>

      {/* Mode tabs */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: '1.5rem',
        borderRadius: 10, overflow: 'hidden',
        border: '1px solid var(--ifm-color-emphasis-200)',
        background: 'var(--ifm-color-emphasis-100)',
        padding: 4,
      }} role="tablist" aria-label="Flashcard modes">
        {Object.entries(MODES).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={mode === key}
            aria-controls={`flashcard-panel-${key}`}
            onClick={() => key === 'review' ? startReview() : setMode(key)}
            style={{
              flex: 1, padding: '10px 16px',
              border: 'none', borderRadius: 8,
              background: mode === key ? 'var(--ifm-background-color)' : 'transparent',
              color: mode === key ? 'var(--ifm-color-primary)' : 'var(--ifm-color-emphasis-600)',
              fontWeight: mode === key ? 700 : 500,
              cursor: 'pointer', fontSize: '0.9em',
              fontFamily: 'inherit',
              boxShadow: mode === key ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.15s',
            }}
          >
            {label}
            {key === 'review' && dueCount > 0 && (
              <span style={{
                marginLeft: 6, padding: '2px 7px', borderRadius: 10,
                background: 'var(--ifm-color-warning-dark)',
                color: '#fff', fontSize: '0.75em', fontWeight: 700,
              }}>{dueCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '0.75rem 1rem', borderRadius: 6, marginBottom: '1rem',
          background: 'var(--ifm-color-danger-contrast-background)',
          border: '1px solid var(--ifm-color-danger-dark)',
          color: 'var(--ifm-color-danger-dark)',
          fontSize: '0.9em',
        }}>
          <span role="alert">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" style={{
            float: 'right', background: 'none', border: 'none',
            cursor: 'pointer', color: 'var(--ifm-color-danger-dark)',
            fontSize: '1.1em', lineHeight: 1,
          }}>&times;</button>
        </div>
      )}

      {/* ── Browse Mode ── */}
      {mode === 'browse' && (
        <div id="flashcard-panel-browse" role="tabpanel" aria-label="Browse flashcards">
          {/* Tag filter */}
          {allTags.length > 0 && (
            <div style={{marginBottom: '1rem', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}>
              <span style={{fontSize: '0.85em', color: 'var(--ifm-color-emphasis-500)', marginRight: 4}}>Filter:</span>
              <button
                onClick={() => setFilterTag('')}
                style={{
                  padding: '4px 10px', borderRadius: 12, border: '1px solid var(--ifm-color-emphasis-200)',
                  background: !filterTag ? 'var(--ifm-color-primary)' : 'transparent',
                  color: !filterTag ? '#fff' : 'var(--ifm-color-emphasis-600)',
                  cursor: 'pointer', fontSize: '0.8em', fontFamily: 'inherit', fontWeight: 500,
                }}
              >All</button>
              {allTags.map(tag => (
                <button
                  key={tag}
                  onClick={() => setFilterTag(tag === filterTag ? '' : tag)}
                  style={{
                    padding: '4px 10px', borderRadius: 12, border: '1px solid var(--ifm-color-emphasis-200)',
                    background: filterTag === tag ? 'var(--ifm-color-primary)' : 'transparent',
                    color: filterTag === tag ? '#fff' : 'var(--ifm-color-emphasis-600)',
                    cursor: 'pointer', fontSize: '0.8em', fontFamily: 'inherit', fontWeight: 500,
                  }}
                >{tag}</button>
              ))}
            </div>
          )}

          {filteredCards.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '3rem 1rem',
              color: 'var(--ifm-color-emphasis-500)',
            }}>
              <p style={{fontSize: '1.1em', marginBottom: 8}}>No flashcards yet.</p>
              <p style={{fontSize: '0.9em'}}>Switch to the Create tab to add your first card.</p>
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 14,
            }}>
              {filteredCards.map(card => (
                <div
                  key={card.id}
                  style={{
                    border: '1px solid var(--ifm-color-emphasis-200)',
                    borderRadius: 10,
                    padding: '1rem 1.1rem',
                    background: 'var(--ifm-background-color)',
                    display: 'flex', flexDirection: 'column', gap: 8,
                    position: 'relative',
                    transition: 'box-shadow 0.15s',
                  }}
                >
                  <button
                    onClick={() => handleDelete(card.id)}
                    title="Delete card"
                    aria-label={`Delete card: ${card.front}`}
                    style={{
                      position: 'absolute', top: 8, right: 10,
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--ifm-color-emphasis-400)', fontSize: '1em',
                      lineHeight: 1, padding: '2px 4px',
                    }}
                  >&times;</button>

                  <div>
                    <div style={{fontSize: '0.7em', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ifm-color-emphasis-400)', marginBottom: 4}}>Front</div>
                    <div style={{fontSize: '0.95em', fontWeight: 600, lineHeight: 1.4}}>{card.front}</div>
                  </div>
                  <div style={{borderTop: '1px dashed var(--ifm-color-emphasis-200)', paddingTop: 8}}>
                    <div style={{fontSize: '0.7em', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ifm-color-emphasis-400)', marginBottom: 4}}>Back</div>
                    <div style={{fontSize: '0.88em', color: 'var(--ifm-color-emphasis-700)', lineHeight: 1.4}}>{card.back}</div>
                  </div>

                  {card.tags && card.tags.length > 0 && (
                    <div style={{display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4}}>
                      {card.tags.map(tag => (
                        <span key={tag} style={{
                          padding: '2px 8px', borderRadius: 10,
                          background: 'var(--ifm-color-info-contrast-background)',
                          color: 'var(--ifm-color-info-dark)',
                          fontSize: '0.72em', fontWeight: 600,
                          border: '1px solid var(--ifm-color-info-dark)',
                        }}>{tag}</span>
                      ))}
                    </div>
                  )}

                  <div style={{
                    fontSize: '0.72em', color: 'var(--ifm-color-emphasis-400)',
                    marginTop: 'auto', paddingTop: 4,
                  }}>
                    {new Date(card.nextReview) <= new Date()
                      ? 'Due now'
                      : `Next: ${new Date(card.nextReview).toLocaleDateString()}`
                    }
                    {card.repetitions > 0 && ` | ${card.repetitions} reviews`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Create Mode ── */}
      {mode === 'create' && (
        <form onSubmit={handleCreate} id="flashcard-panel-create" role="tabpanel" aria-label="Create flashcard" style={{
          maxWidth: 600, margin: '0 auto',
          padding: '1.5rem',
          borderRadius: 12,
          border: '2px dashed var(--ifm-color-primary)',
          background: 'var(--ifm-color-emphasis-0)',
        }}>
          <h3 style={{margin: '0 0 16px', fontSize: '1.1em'}}>Create a new flashcard</h3>

          <label style={{display: 'block', marginBottom: 12}}>
            <span style={{fontSize: '0.85em', fontWeight: 600, color: 'var(--ifm-color-emphasis-600)'}}>Front (question/prompt)</span>
            <textarea
              value={front}
              onChange={e => setFront(e.target.value)}
              placeholder="What is the time complexity of binary search?"
              required
              rows={3}
              style={{
                display: 'block', width: '100%', padding: '10px 12px', borderRadius: 6,
                border: '1px solid var(--ifm-color-emphasis-300)',
                fontSize: '0.95em', marginTop: 6, boxSizing: 'border-box',
                resize: 'vertical', fontFamily: 'inherit',
                backgroundColor: 'var(--ifm-background-color)',
                color: 'var(--ifm-font-color-base)',
              }}
            />
          </label>

          <label style={{display: 'block', marginBottom: 12}}>
            <span style={{fontSize: '0.85em', fontWeight: 600, color: 'var(--ifm-color-emphasis-600)'}}>Back (answer)</span>
            <textarea
              value={back}
              onChange={e => setBack(e.target.value)}
              placeholder="O(log n) - it halves the search space each step."
              required
              rows={3}
              style={{
                display: 'block', width: '100%', padding: '10px 12px', borderRadius: 6,
                border: '1px solid var(--ifm-color-emphasis-300)',
                fontSize: '0.95em', marginTop: 6, boxSizing: 'border-box',
                resize: 'vertical', fontFamily: 'inherit',
                backgroundColor: 'var(--ifm-background-color)',
                color: 'var(--ifm-font-color-base)',
              }}
            />
          </label>

          <label style={{display: 'block', marginBottom: 12}}>
            <span style={{fontSize: '0.85em', fontWeight: 600, color: 'var(--ifm-color-emphasis-600)'}}>Tags (comma-separated, optional)</span>
            <input
              type="text"
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder="algorithms, complexity, search"
              style={{
                display: 'block', width: '100%', padding: '10px 12px', borderRadius: 6,
                border: '1px solid var(--ifm-color-emphasis-300)',
                fontSize: '0.95em', marginTop: 6, boxSizing: 'border-box',
                backgroundColor: 'var(--ifm-background-color)',
                color: 'var(--ifm-font-color-base)',
              }}
            />
          </label>

          <label style={{display: 'block', marginBottom: 16}}>
            <span style={{fontSize: '0.85em', fontWeight: 600, color: 'var(--ifm-color-emphasis-600)'}}>Source (optional)</span>
            <input
              type="text"
              value={source}
              onChange={e => setSource(e.target.value)}
              placeholder="e.g., guides/algorithms.md"
              style={{
                display: 'block', width: '100%', padding: '10px 12px', borderRadius: 6,
                border: '1px solid var(--ifm-color-emphasis-300)',
                fontSize: '0.95em', marginTop: 6, boxSizing: 'border-box',
                backgroundColor: 'var(--ifm-background-color)',
                color: 'var(--ifm-font-color-base)',
              }}
            />
          </label>

          <button
            type="submit"
            disabled={creating || !front.trim() || !back.trim()}
            style={{
              padding: '10px 24px', border: 'none', borderRadius: 8,
              background: creating ? 'var(--ifm-color-emphasis-200)' : 'var(--ifm-color-primary)',
              color: creating ? 'var(--ifm-color-emphasis-500)' : '#fff',
              cursor: creating ? 'not-allowed' : 'pointer',
              fontSize: '0.95em', fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            {creating ? 'Creating...' : 'Create Card'}
          </button>
        </form>
      )}

      {/* ── Review Mode ── */}
      {mode === 'review' && (
        <div id="flashcard-panel-review" role="tabpanel" aria-label="Review flashcards" style={{maxWidth: 560, margin: '0 auto'}}>
          {reviewLoading && reviewCards.length === 0 ? (
            <div style={{textAlign: 'center', padding: '3rem', color: 'var(--ifm-color-emphasis-500)'}}>
              Loading review cards...
            </div>
          ) : reviewDone ? (
            <div style={{
              textAlign: 'center', padding: '3rem 1rem',
              borderRadius: 12,
              border: '1px solid var(--ifm-color-emphasis-200)',
              background: 'var(--ifm-background-color)',
            }}>
              <div style={{fontSize: '2em', marginBottom: 12}}>&#10003;</div>
              <h3 style={{margin: '0 0 8px', fontSize: '1.2em'}}>
                {sessionReviewed > 0 ? 'Session Complete!' : 'All caught up!'}
              </h3>
              <p style={{color: 'var(--ifm-color-emphasis-600)', fontSize: '0.9em', margin: '0 0 16px'}}>
                {sessionReviewed > 0
                  ? `You reviewed ${sessionReviewed} card${sessionReviewed !== 1 ? 's' : ''} this session.`
                  : 'No cards are due for review right now. Check back later.'}
              </p>
              <button
                onClick={() => setMode('browse')}
                style={{
                  padding: '10px 24px', border: 'none', borderRadius: 8,
                  background: 'var(--ifm-color-primary)',
                  color: '#fff', cursor: 'pointer',
                  fontSize: '0.9em', fontWeight: 600, fontFamily: 'inherit',
                }}
              >
                Back to Browse
              </button>
            </div>
          ) : (
            <div>
              {/* Progress */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: 16, fontSize: '0.85em', color: 'var(--ifm-color-emphasis-500)',
              }}>
                <span>Card {reviewIndex + 1} of {reviewCards.length}</span>
                <span>{sessionReviewed} reviewed this session</span>
              </div>

              {/* Progress bar */}
              <div role="progressbar" aria-valuenow={reviewIndex} aria-valuemin={0} aria-valuemax={reviewCards.length} aria-label={`Review progress: ${reviewIndex} of ${reviewCards.length} cards`} style={{
                height: 4, borderRadius: 2, background: 'var(--ifm-color-emphasis-200)',
                marginBottom: 20, overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  background: 'var(--ifm-color-primary)',
                  width: `${((reviewIndex) / reviewCards.length) * 100}%`,
                  transition: 'width 0.3s ease',
                }} />
              </div>

              {/* Card with flip animation */}
              <div
                onClick={() => setFlipped(!flipped)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFlipped(!flipped); } }}
                role="button"
                tabIndex={0}
                aria-label={flipped ? 'Flashcard showing answer. Press to show question.' : 'Flashcard showing question. Press to reveal answer.'}
                aria-live="polite"
                style={{
                  perspective: '1000px',
                  cursor: 'pointer',
                  marginBottom: 20,
                  minHeight: 220,
                }}
              >
                <div style={{
                  position: 'relative',
                  width: '100%',
                  minHeight: 220,
                  transition: 'transform 0.5s',
                  transformStyle: 'preserve-3d',
                  transform: flipped ? 'rotateY(180deg)' : 'rotateY(0)',
                }}>
                  {/* Front face */}
                  <div style={{
                    position: 'absolute', width: '100%', minHeight: 220,
                    backfaceVisibility: 'hidden',
                    WebkitBackfaceVisibility: 'hidden',
                    borderRadius: 14,
                    border: '2px solid var(--ifm-color-primary)',
                    background: 'var(--ifm-background-color)',
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    padding: '2rem 1.5rem',
                    boxSizing: 'border-box',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.06)',
                  }}>
                    <div style={{
                      fontSize: '0.7em', fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.1em', color: 'var(--ifm-color-primary)',
                      marginBottom: 16,
                    }}>Question</div>
                    <div style={{
                      fontSize: '1.15em', fontWeight: 600, textAlign: 'center',
                      lineHeight: 1.5, color: 'var(--ifm-font-color-base)',
                    }}>
                      {reviewCards[reviewIndex]?.front}
                    </div>
                    <div style={{
                      marginTop: 20, fontSize: '0.78em',
                      color: 'var(--ifm-color-emphasis-400)',
                    }}>
                      Click to reveal answer
                    </div>
                  </div>

                  {/* Back face */}
                  <div style={{
                    position: 'absolute', width: '100%', minHeight: 220,
                    backfaceVisibility: 'hidden',
                    WebkitBackfaceVisibility: 'hidden',
                    borderRadius: 14,
                    border: '2px solid var(--ifm-color-success-dark)',
                    background: 'var(--ifm-background-color)',
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    padding: '2rem 1.5rem',
                    boxSizing: 'border-box',
                    transform: 'rotateY(180deg)',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.06)',
                  }}>
                    <div style={{
                      fontSize: '0.7em', fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.1em', color: 'var(--ifm-color-success-dark)',
                      marginBottom: 16,
                    }}>Answer</div>
                    <div style={{
                      fontSize: '1.1em', textAlign: 'center',
                      lineHeight: 1.5, color: 'var(--ifm-font-color-base)',
                    }}>
                      {reviewCards[reviewIndex]?.back}
                    </div>
                  </div>
                </div>
              </div>

              {/* Rating buttons - only show when flipped */}
              {flipped && (
                <div role="group" aria-label="Rate your recall" style={{
                  display: 'flex', gap: 8, justifyContent: 'center',
                  flexWrap: 'wrap',
                }}>
                  {[
                    {q: 1, label: 'Again', color: 'var(--ifm-color-danger-dark)', bg: 'var(--ifm-color-danger-contrast-background)'},
                    {q: 2, label: 'Hard', color: 'var(--ifm-color-warning-dark)', bg: 'var(--ifm-color-warning-contrast-background)'},
                    {q: 3, label: 'Okay', color: 'var(--ifm-color-emphasis-600)', bg: 'var(--ifm-color-emphasis-100)'},
                    {q: 4, label: 'Good', color: 'var(--ifm-color-info-dark)', bg: 'var(--ifm-color-info-contrast-background)'},
                    {q: 5, label: 'Easy', color: 'var(--ifm-color-success-dark)', bg: 'var(--ifm-color-success-contrast-background)'},
                  ].map(({q, label, color, bg}) => (
                    <button
                      key={q}
                      onClick={(e) => { e.stopPropagation(); handleReview(q); }}
                      disabled={reviewLoading}
                      style={{
                        padding: '10px 18px', borderRadius: 8,
                        border: `1px solid ${color}`,
                        background: bg, color: color,
                        cursor: reviewLoading ? 'not-allowed' : 'pointer',
                        fontSize: '0.88em', fontWeight: 600,
                        fontFamily: 'inherit',
                        opacity: reviewLoading ? 0.5 : 1,
                        transition: 'opacity 0.15s',
                        minWidth: 70,
                      }}
                    >
                      <div style={{fontSize: '0.75em', marginBottom: 2}}>{q}</div>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function FlashcardsPage() {
  return (
    <Layout title="Flashcards" description="Spaced repetition flashcard study system">
      <main>
        <BrowserOnly fallback={
          <div style={{textAlign: 'center', padding: '4rem', color: 'var(--ifm-color-emphasis-500)'}}>
            Loading...
          </div>
        }>
          {() => <ErrorBoundary><FlashcardsApp /></ErrorBoundary>}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
