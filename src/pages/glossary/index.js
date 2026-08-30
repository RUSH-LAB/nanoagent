import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE, { apiFetch } from '@site/src/utils/api';
import {useDebounce} from '@site/src/hooks/useDebounce';
import pageStyles from '@site/src/css/page.module.css';

/* ── Category color mapping ──────────────────────────────────── */

const CATEGORY_COLORS = {
  ML:   { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.4)', text: '#2563eb' },
  Math: { bg: 'rgba(168,85,247,0.12)', border: 'rgba(168,85,247,0.4)', text: '#7c3aed' },
  CS:   { bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.4)',  text: '#16a34a' },
  NLP:  { bg: 'rgba(251,146,60,0.12)', border: 'rgba(251,146,60,0.4)', text: '#ea580c' },
  Stats:{ bg: 'rgba(236,72,153,0.12)', border: 'rgba(236,72,153,0.4)', text: '#db2777' },
};

function categoryStyle(cat) {
  const c = CATEGORY_COLORS[cat];
  if (c) return { backgroundColor: c.bg, borderColor: c.border, color: c.text };
  return {
    backgroundColor: 'var(--ifm-color-emphasis-100)',
    borderColor: 'var(--ifm-color-emphasis-300)',
    color: 'var(--ifm-color-emphasis-700)',
  };
}

/* ── Category tag badge ──────────────────────────────────────── */

function CategoryBadge({ category, onClick, active }) {
  if (!category) return null;
  const style = categoryStyle(category);
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: '12px',
        fontSize: '0.75em',
        fontWeight: 600,
        fontFamily: 'inherit',
        border: `1px solid ${style.borderColor}`,
        backgroundColor: active ? style.borderColor : style.backgroundColor,
        color: active ? '#fff' : style.color,
        cursor: 'pointer',
        transition: 'background 0.15s, color 0.15s',
        lineHeight: '1.6',
      }}
    >
      {category}
    </button>
  );
}

/* ── Letter nav bar ──────────────────────────────────────────── */

function LetterNav({ letters }) {
  return (
    <nav aria-label="Alphabetical navigation" style={{
      display: 'flex',
      gap: '4px',
      flexWrap: 'wrap',
      marginBottom: '20px',
      padding: '8px 0',
      borderBottom: '1px solid var(--ifm-color-emphasis-200)',
    }}>
      {letters.map(letter => (
        <button
          key={letter}
          aria-label={`Jump to letter ${letter}`}
          onClick={() => {
            const el = document.getElementById(`glossary-letter-${letter}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '6px',
            border: '1px solid var(--ifm-color-emphasis-200)',
            background: 'transparent',
            color: 'var(--ifm-font-color-base)',
            cursor: 'pointer',
            fontSize: '0.85em',
            fontWeight: 700,
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.15s, color 0.15s',
          }}
        >
          {letter}
        </button>
      ))}
    </nav>
  );
}

/* ── Add / Edit term form ────────────────────────────────────── */

function TermForm({ onSubmit, onCancel, initial, allCategories }) {
  const [term, setTerm] = useState(initial?.term || '');
  const [definition, setDefinition] = useState(initial?.definition || '');
  const [category, setCategory] = useState(initial?.category || '');
  const [relatedTerms, setRelatedTerms] = useState((initial?.relatedTerms || []).join(', '));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const termRef = useRef(null);

  useEffect(() => {
    if (termRef.current && !initial) termRef.current.focus();
  }, [initial]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!term.trim() || !definition.trim()) {
      setError('Term and definition are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        term: term.trim(),
        definition: definition.trim(),
        category: category.trim(),
        relatedTerms: relatedTerms.split(',').map(s => s.trim()).filter(Boolean),
      });
    } catch (err) {
      setError(err.message || 'Failed to save term.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: '6px',
    border: '1px solid var(--ifm-color-emphasis-300)',
    fontSize: '0.95em',
    backgroundColor: 'var(--ifm-background-color)',
    color: 'var(--ifm-font-color-base)',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
  };

  return (
    <form onSubmit={handleSubmit} style={{
      border: '1px solid var(--ifm-color-emphasis-200)',
      borderRadius: '8px',
      padding: '1.25rem',
      marginBottom: '1.5rem',
      background: 'var(--ifm-color-emphasis-0)',
    }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: '1em' }}>
        {initial ? 'Edit Term' : 'Add New Term'}
      </h3>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '0.82em', fontWeight: 600, marginBottom: '4px' }}>Term</label>
        <input
          ref={termRef}
          type="text"
          value={term}
          onChange={e => setTerm(e.target.value)}
          placeholder="e.g., Transformer"
          style={inputStyle}
          disabled={!!initial}
        />
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label style={{ display: 'block', fontSize: '0.82em', fontWeight: 600, marginBottom: '4px' }}>Definition</label>
        <textarea
          value={definition}
          onChange={e => setDefinition(e.target.value)}
          placeholder="A clear, concise definition..."
          rows={4}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </div>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label style={{ display: 'block', fontSize: '0.82em', fontWeight: 600, marginBottom: '4px' }}>Category</label>
          <input
            type="text"
            value={category}
            onChange={e => setCategory(e.target.value)}
            placeholder="e.g., ML, Math, CS, NLP, Stats"
            list="glossary-categories"
            style={inputStyle}
          />
          {allCategories.length > 0 && (
            <datalist id="glossary-categories">
              {allCategories.map(c => <option key={c} value={c} />)}
            </datalist>
          )}
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <label style={{ display: 'block', fontSize: '0.82em', fontWeight: 600, marginBottom: '4px' }}>Related Terms (comma-separated)</label>
          <input
            type="text"
            value={relatedTerms}
            onChange={e => setRelatedTerms(e.target.value)}
            placeholder="e.g., Attention, BERT, GPT"
            style={inputStyle}
          />
        </div>
      </div>

      {error && (
        <div style={{
          padding: '6px 12px',
          borderRadius: '4px',
          fontSize: '0.85em',
          color: 'var(--ifm-color-danger-dark)',
          background: 'var(--ifm-color-danger-contrast-background)',
          border: '1px solid var(--ifm-color-danger-dark)',
          marginBottom: '10px',
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '8px 16px',
              border: '1px solid var(--ifm-color-emphasis-300)',
              borderRadius: '6px',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '0.85em',
              fontFamily: 'inherit',
              color: 'var(--ifm-font-color-base)',
            }}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '8px 20px',
            border: 'none',
            borderRadius: '6px',
            background: submitting ? 'var(--ifm-color-emphasis-200)' : 'var(--ifm-color-primary)',
            color: submitting ? 'var(--ifm-color-emphasis-500)' : '#fff',
            cursor: submitting ? 'not-allowed' : 'pointer',
            fontSize: '0.85em',
            fontWeight: 600,
            fontFamily: 'inherit',
          }}
        >
          {submitting ? 'Saving...' : initial ? 'Update' : 'Add Term'}
        </button>
      </div>
    </form>
  );
}

/* ── Single term entry ───────────────────────────────────────── */

function TermEntry({ entry, expanded, onToggle, onEdit, onDelete, onCategoryClick }) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div style={{
      padding: '12px 16px',
      marginBottom: '6px',
      borderRadius: '6px',
      border: expanded
        ? '1px solid var(--ifm-color-primary-lightest)'
        : '1px solid var(--ifm-color-emphasis-200)',
      background: expanded ? 'var(--ifm-color-emphasis-0)' : 'transparent',
      transition: 'border-color 0.15s, background 0.15s',
    }}>
      <div
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${entry.term}${entry.category ? `, category: ${entry.category}` : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{
          fontWeight: 700,
          fontSize: '1em',
          color: 'var(--ifm-font-color-base)',
          flex: 1,
        }}>
          {entry.term}
        </span>
        {entry.category && (
          <CategoryBadge
            category={entry.category}
            onClick={(e) => { e.stopPropagation(); onCategoryClick(entry.category); }}
          />
        )}
        <span style={{
          fontSize: '0.85em',
          color: 'var(--ifm-color-emphasis-400)',
          transition: 'transform 0.15s',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
        }}>
          &#9662;
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop: '10px' }}>
          <p style={{
            margin: '0 0 8px 0',
            fontSize: '0.95em',
            lineHeight: 1.6,
            color: 'var(--ifm-font-color-base)',
          }}>
            {entry.definition}
          </p>

          {entry.relatedTerms && entry.relatedTerms.length > 0 && (
            <div style={{ fontSize: '0.85em', marginBottom: '8px' }}>
              <strong style={{ color: 'var(--ifm-color-emphasis-600)' }}>Related: </strong>
              {entry.relatedTerms.map((rt, i) => (
                <span key={rt}>
                  <span style={{
                    color: 'var(--ifm-color-primary)',
                    cursor: 'default',
                  }}>
                    {rt}
                  </span>
                  {i < entry.relatedTerms.length - 1 ? ', ' : ''}
                </span>
              ))}
            </div>
          )}

          <div style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            borderTop: '1px solid var(--ifm-color-emphasis-100)',
            paddingTop: '8px',
            marginTop: '4px',
          }}>
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(entry); }}
              style={{
                padding: '4px 12px',
                border: '1px solid var(--ifm-color-emphasis-300)',
                borderRadius: '4px',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: '0.8em',
                fontFamily: 'inherit',
                color: 'var(--ifm-font-color-base)',
              }}
            >
              Edit
            </button>
            {!confirmDelete ? (
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                style={{
                  padding: '4px 12px',
                  border: '1px solid var(--ifm-color-danger)',
                  borderRadius: '4px',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: '0.8em',
                  fontFamily: 'inherit',
                  color: 'var(--ifm-color-danger)',
                }}
              >
                Delete
              </button>
            ) : (
              <>
                <span style={{ fontSize: '0.8em', color: 'var(--ifm-color-danger)' }}>
                  Are you sure?
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(entry.term); setConfirmDelete(false); }}
                  style={{
                    padding: '4px 12px',
                    border: 'none',
                    borderRadius: '4px',
                    background: 'var(--ifm-color-danger)',
                    cursor: 'pointer',
                    fontSize: '0.8em',
                    fontFamily: 'inherit',
                    color: '#fff',
                    fontWeight: 600,
                  }}
                >
                  Yes, delete
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                  style={{
                    padding: '4px 12px',
                    border: '1px solid var(--ifm-color-emphasis-300)',
                    borderRadius: '4px',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: '0.8em',
                    fontFamily: 'inherit',
                    color: 'var(--ifm-font-color-base)',
                  }}
                >
                  No
                </button>
              </>
            )}
            <span style={{
              marginLeft: 'auto',
              fontSize: '0.75em',
              color: 'var(--ifm-color-emphasis-400)',
            }}>
              Updated {new Date(entry.updatedAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main glossary component (client-only) ───────────────────── */

function GlossaryContent() {
  const [terms, setTerms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [expandedTerm, setExpandedTerm] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingTerm, setEditingTerm] = useState(null);

  const fetchTerms = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch(`${API_BASE}/api/glossary`)
      .then(r => {
        if (!r.ok) throw new Error(`Server returned ${r.status}`);
        return r.json();
      })
      .then(data => {
        setTerms(data.terms || []);
        setLoading(false);
      })
      .catch(err => {
        setError('Failed to load glossary: ' + err.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => { fetchTerms(); }, [fetchTerms]);

  const allCategories = useMemo(() => {
    const cats = new Set();
    for (const t of terms) {
      if (t.category) cats.add(t.category);
    }
    return [...cats].sort();
  }, [terms]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.toLowerCase().trim();
    return terms.filter(t => {
      if (categoryFilter && t.category !== categoryFilter) return false;
      if (!q) return true;
      return (t.term || '').toLowerCase().includes(q) ||
        (t.definition || '').toLowerCase().includes(q) ||
        (t.category || '').toLowerCase().includes(q) ||
        (t.relatedTerms || []).some(r => r.toLowerCase().includes(q));
    });
  }, [terms, debouncedSearch, categoryFilter]);

  // Group by first letter
  const letterGroups = useMemo(() => {
    const groups = {};
    for (const t of filtered) {
      const first = (t.term || '?')[0].toUpperCase();
      const letter = /[A-Z]/.test(first) ? first : '#';
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(t);
    }
    const letters = Object.keys(groups).sort((a, b) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b);
    });
    return letters.map(letter => ({ letter, entries: groups[letter] }));
  }, [filtered]);

  const allLetters = useMemo(() => letterGroups.map(g => g.letter), [letterGroups]);

  const handleAdd = async (data) => {
    const r = await apiFetch(`${API_BASE}/api/glossary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await r.json();
    if (result.error) throw new Error(result.error);
    setShowAddForm(false);
    fetchTerms();
  };

  const handleUpdate = async (data) => {
    const r = await apiFetch(`${API_BASE}/api/glossary`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await r.json();
    if (result.error) throw new Error(result.error);
    setEditingTerm(null);
    fetchTerms();
  };

  const handleDelete = async (term) => {
    const r = await apiFetch(`${API_BASE}/api/glossary`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term }),
    });
    const result = await r.json();
    if (result.error) {
      setError(result.error);
      return;
    }
    fetchTerms();
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--ifm-color-emphasis-500)' }}>
        Loading glossary...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        padding: '1rem',
        borderRadius: '6px',
        color: 'var(--ifm-color-danger-dark)',
        background: 'var(--ifm-color-danger-contrast-background)',
        border: '1px solid var(--ifm-color-danger-dark)',
      }}>
        {error}
        <button
          onClick={fetchTerms}
          style={{
            marginLeft: '12px',
            padding: '4px 12px',
            border: '1px solid var(--ifm-color-emphasis-300)',
            borderRadius: '4px',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: '0.85em',
            fontFamily: 'inherit',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '1rem',
        flexWrap: 'wrap',
        gap: '8px',
      }}>
        <h1 style={{ margin: 0 }}>Glossary</h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{
            fontSize: '0.85em',
            color: 'var(--ifm-color-emphasis-500)',
            padding: '4px 12px',
            borderRadius: '16px',
            border: '1px solid var(--ifm-color-emphasis-200)',
            background: 'var(--ifm-color-emphasis-100)',
          }}>
            {terms.length} {terms.length === 1 ? 'term' : 'terms'}
          </span>
          <button
            onClick={() => { setShowAddForm(!showAddForm); setEditingTerm(null); }}
            style={{
              padding: '8px 16px',
              border: 'none',
              borderRadius: '6px',
              background: showAddForm ? 'var(--ifm-color-emphasis-300)' : 'var(--ifm-color-primary)',
              color: showAddForm ? 'var(--ifm-font-color-base)' : '#fff',
              cursor: 'pointer',
              fontSize: '0.85em',
              fontWeight: 600,
              fontFamily: 'inherit',
              transition: 'background 0.15s',
            }}
          >
            {showAddForm ? 'Cancel' : '+ Add Term'}
          </button>
        </div>
      </div>

      <p style={{ color: 'var(--ifm-color-emphasis-600)', marginBottom: '1rem', fontSize: '0.95em' }}>
        Terminology reference for concepts across the site. Click a term to expand its definition.
      </p>

      {/* Add form */}
      {showAddForm && (
        <TermForm
          onSubmit={handleAdd}
          onCancel={() => setShowAddForm(false)}
          allCategories={allCategories}
        />
      )}

      {/* Edit form */}
      {editingTerm && (
        <TermForm
          initial={editingTerm}
          onSubmit={handleUpdate}
          onCancel={() => setEditingTerm(null)}
          allCategories={allCategories}
        />
      )}

      {/* Search + category filter bar */}
      <div style={{
        display: 'flex',
        gap: '12px',
        marginBottom: '16px',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}>
        <input
          type="search"
          placeholder="Search terms, definitions..."
          aria-label="Search glossary terms"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: '1 1 280px',
            padding: '8px 12px',
            borderRadius: '6px',
            border: '1px solid var(--ifm-color-emphasis-300)',
            fontSize: '0.95em',
            backgroundColor: 'var(--ifm-background-color)',
            color: 'var(--ifm-font-color-base)',
          }}
        />
        {allCategories.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {categoryFilter && (
              <button
                onClick={() => setCategoryFilter('')}
                aria-label="Clear category filter, show all terms"
                style={{
                  padding: '2px 10px',
                  borderRadius: '12px',
                  fontSize: '0.75em',
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  border: '1px solid var(--ifm-color-emphasis-300)',
                  background: 'var(--ifm-color-emphasis-100)',
                  color: 'var(--ifm-color-emphasis-600)',
                  cursor: 'pointer',
                  lineHeight: '1.6',
                }}
              >
                All
              </button>
            )}
            {allCategories.map(cat => (
              <CategoryBadge
                key={cat}
                category={cat}
                active={categoryFilter === cat}
                onClick={() => setCategoryFilter(prev => prev === cat ? '' : cat)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Letter navigation */}
      {allLetters.length > 1 && <LetterNav letters={allLetters} />}

      {/* Term list */}
      {letterGroups.length === 0 ? (
        <p style={{
          textAlign: 'center',
          color: 'var(--ifm-color-emphasis-500)',
          padding: '2rem',
        }}>
          {terms.length === 0
            ? 'No terms yet. Add your first term above!'
            : 'No terms match your search.'}
        </p>
      ) : (
        letterGroups.map(({ letter, entries }) => (
          <div key={letter} style={{ marginBottom: '24px' }}>
            <h2
              id={`glossary-letter-${letter}`}
              style={{
                scrollMarginTop: '80px',
                margin: '0 0 8px 0',
                paddingBottom: '4px',
                borderBottom: '2px solid var(--ifm-color-emphasis-200)',
                fontSize: '1.3em',
                color: 'var(--ifm-color-primary)',
                letterSpacing: '0.02em',
              }}
            >
              {letter}
              <span style={{
                fontSize: '0.55em',
                fontWeight: 400,
                color: 'var(--ifm-color-emphasis-400)',
                marginLeft: '8px',
              }}>
                {entries.length}
              </span>
            </h2>
            {entries.map(entry => (
              <TermEntry
                key={entry.term}
                entry={entry}
                expanded={expandedTerm === entry.term}
                onToggle={() => setExpandedTerm(prev => prev === entry.term ? null : entry.term)}
                onEdit={(e) => { setEditingTerm(e); setShowAddForm(false); }}
                onDelete={handleDelete}
                onCategoryClick={setCategoryFilter}
              />
            ))}
          </div>
        ))
      )}

      {/* Showing count */}
      {filtered.length > 0 && filtered.length !== terms.length && (
        <p aria-live="polite" style={{
          fontSize: '0.85em',
          color: 'var(--ifm-color-emphasis-500)',
          textAlign: 'center',
          marginTop: '8px',
        }}>
          Showing {filtered.length} of {terms.length} terms
        </p>
      )}
    </>
  );
}

/* ── Page wrapper ────────────────────────────────────────────── */

export default function GlossaryPage() {
  return (
    <Layout title="Glossary" description="Terminology reference for Mochi Lab">
      <main className={pageStyles.pageContainer}>
        <BrowserOnly>
          {() => <ErrorBoundary><GlossaryContent /></ErrorBoundary>}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
