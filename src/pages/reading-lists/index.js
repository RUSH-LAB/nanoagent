import React, {useState, useEffect, useCallback} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import pageStyles from '@site/src/css/page.module.css';

function ReadingListsApp() {
  const { default: API_BASE, apiFetch } = require('@site/src/utils/api');

  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // New-list form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // Add-item form (keyed by list id)
  const [addingTo, setAddingTo] = useState(null);
  const [itemPath, setItemPath] = useState('');
  const [itemTitle, setItemTitle] = useState('');
  const [itemType, setItemType] = useState('doc');
  const [addingItem, setAddingItem] = useState(false);

  // Expanded list (show items)
  const [expandedId, setExpandedId] = useState(null);

  const fetchLists = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/reading-lists`);
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setLists(data.lists || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLists(); }, [fetchLists]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/reading-lists`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: newName.trim(), description: newDesc.trim()}),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      setNewName('');
      setNewDesc('');
      setShowNewForm(false);
      await fetchLists();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteList = async (listId) => {
    if (!confirm('Delete this reading list?')) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/reading-lists/${listId}`, {method: 'DELETE'});
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      await fetchLists();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAddItem = async (e, listId) => {
    e.preventDefault();
    if (!itemPath.trim() || addingItem) return;
    setAddingItem(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/reading-lists/${listId}/items`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: itemPath.trim(), title: itemTitle.trim(), type: itemType}),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      setItemPath('');
      setItemTitle('');
      setItemType('doc');
      setAddingTo(null);
      await fetchLists();
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingItem(false);
    }
  };

  const handleRemoveItem = async (listId, itemPath) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/reading-lists/${listId}/items`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: itemPath}),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      await fetchLists();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleMoveItem = async (listId, itemPath, direction) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/reading-lists/${listId}/items`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: itemPath, direction}),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      await fetchLists();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div style={{textAlign: 'center', padding: '4rem', color: 'var(--ifm-color-emphasis-500)'}}>
        Loading reading lists...
      </div>
    );
  }

  return (
    <div className={pageStyles.pageContainer}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '1.5rem', flexWrap: 'wrap', gap: '12px',
      }}>
        <div>
          <h1 style={{margin: 0, fontSize: '1.8em'}}>Reading Lists</h1>
          <p style={{margin: '4px 0 0', color: 'var(--ifm-color-emphasis-600)', fontSize: '0.9em'}}>
            Create ordered reading lists of papers and documentation pages.
          </p>
        </div>
        <button
          onClick={() => setShowNewForm(!showNewForm)}
          style={{
            padding: '10px 20px',
            border: 'none',
            borderRadius: 8,
            background: 'var(--ifm-color-primary)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '0.9em',
            fontWeight: 600,
            fontFamily: 'inherit',
          }}
        >
          {showNewForm ? 'Cancel' : '+ New List'}
        </button>
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
          {error}
          <button onClick={() => setError(null)} style={{
            float: 'right', background: 'none', border: 'none',
            cursor: 'pointer', color: 'var(--ifm-color-danger-dark)',
            fontSize: '1.1em', lineHeight: 1,
          }}>&times;</button>
        </div>
      )}

      {/* New list form */}
      {showNewForm && (
        <form onSubmit={handleCreate} style={{
          padding: '1.25rem', borderRadius: 10,
          border: '2px dashed var(--ifm-color-primary)',
          background: 'var(--ifm-color-emphasis-0)',
          marginBottom: '1.5rem',
        }}>
          <h3 style={{margin: '0 0 12px', fontSize: '1em'}}>Create a new reading list</h3>
          <input
            type="text"
            placeholder="List name (e.g., Transformer Papers)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            required
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 6,
              border: '1px solid var(--ifm-color-emphasis-300)',
              fontSize: '0.95em', marginBottom: 10, boxSizing: 'border-box',
              backgroundColor: 'var(--ifm-background-color)',
              color: 'var(--ifm-font-color-base)',
            }}
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 6,
              border: '1px solid var(--ifm-color-emphasis-300)',
              fontSize: '0.95em', marginBottom: 12, boxSizing: 'border-box',
              backgroundColor: 'var(--ifm-background-color)',
              color: 'var(--ifm-font-color-base)',
            }}
          />
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            style={{
              padding: '8px 20px', border: 'none', borderRadius: 6,
              background: creating ? 'var(--ifm-color-emphasis-200)' : 'var(--ifm-color-primary)',
              color: creating ? 'var(--ifm-color-emphasis-500)' : '#fff',
              cursor: creating ? 'not-allowed' : 'pointer',
              fontSize: '0.9em', fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            {creating ? 'Creating...' : 'Create List'}
          </button>
        </form>
      )}

      {/* Lists */}
      {lists.length === 0 && !showNewForm && (
        <div style={{
          textAlign: 'center', padding: '3rem 1rem',
          color: 'var(--ifm-color-emphasis-500)',
        }}>
          <p style={{fontSize: '1.1em', marginBottom: 8}}>No reading lists yet.</p>
          <p style={{fontSize: '0.9em'}}>Click "New List" to create your first reading list.</p>
        </div>
      )}

      {lists.map(list => {
        const isExpanded = expandedId === list.id;
        const itemCount = list.items?.length || 0;

        return (
          <div
            key={list.id}
            style={{
              border: '1px solid var(--ifm-color-emphasis-200)',
              borderRadius: 10,
              marginBottom: '1rem',
              background: 'var(--ifm-background-color)',
              overflow: 'hidden',
              transition: 'box-shadow 0.15s',
              boxShadow: isExpanded ? '0 2px 12px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            {/* Card header */}
            <div
              onClick={() => setExpandedId(isExpanded ? null : list.id)}
              style={{
                padding: '1rem 1.25rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                userSelect: 'none',
              }}
            >
              <span style={{
                fontSize: '1.2em',
                color: 'var(--ifm-color-emphasis-400)',
                transition: 'transform 0.15s',
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0)',
                display: 'inline-block',
              }}>&#9654;</span>
              <div style={{flex: 1, minWidth: 0}}>
                <div style={{fontWeight: 600, fontSize: '1.05em'}}>{list.name}</div>
                {list.description && (
                  <div style={{fontSize: '0.85em', color: 'var(--ifm-color-emphasis-600)', marginTop: 2}}>
                    {list.description}
                  </div>
                )}
              </div>
              <span style={{
                fontSize: '0.8em', padding: '3px 10px', borderRadius: 12,
                background: 'var(--ifm-color-emphasis-100)',
                color: 'var(--ifm-color-emphasis-600)',
                fontWeight: 600, whiteSpace: 'nowrap',
              }}>
                {itemCount} {itemCount === 1 ? 'item' : 'items'}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteList(list.id); }}
                title="Delete list"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--ifm-color-emphasis-400)', fontSize: '1.1em',
                  padding: '4px 6px', lineHeight: 1,
                  borderRadius: 4,
                }}
              >
                &#128465;
              </button>
            </div>

            {/* Expanded content */}
            {isExpanded && (
              <div style={{
                borderTop: '1px solid var(--ifm-color-emphasis-200)',
                padding: '1rem 1.25rem',
              }}>
                {/* Items list */}
                {list.items && list.items.length > 0 ? (
                  <ol style={{margin: 0, padding: 0, listStyle: 'none'}}>
                    {list.items.map((item, idx) => (
                      <li
                        key={item.path}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '10px 12px',
                          borderRadius: 6,
                          marginBottom: 6,
                          background: 'var(--ifm-color-emphasis-0)',
                          border: '1px solid var(--ifm-color-emphasis-100)',
                        }}
                      >
                        {/* Position number */}
                        <span style={{
                          fontWeight: 700, fontSize: '0.85em',
                          color: 'var(--ifm-color-emphasis-400)',
                          minWidth: 24, textAlign: 'center',
                        }}>
                          {idx + 1}
                        </span>

                        {/* Type badge */}
                        <span style={{
                          fontSize: '0.7em', padding: '2px 6px', borderRadius: 4,
                          fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em',
                          background: item.type === 'reference'
                            ? 'var(--ifm-color-warning-contrast-background)'
                            : 'var(--ifm-color-info-contrast-background)',
                          color: item.type === 'reference'
                            ? 'var(--ifm-color-warning-dark)'
                            : 'var(--ifm-color-info-dark)',
                          border: `1px solid ${item.type === 'reference' ? 'var(--ifm-color-warning-dark)' : 'var(--ifm-color-info-dark)'}`,
                          whiteSpace: 'nowrap',
                        }}>
                          {item.type === 'reference' ? 'Paper' : 'Doc'}
                        </span>

                        {/* Title/link */}
                        <div style={{flex: 1, minWidth: 0}}>
                          <Link
                            to={item.type === 'reference' ? `/bibliography/${item.path}` : `/${item.path}`}
                            style={{
                              fontWeight: 500, fontSize: '0.92em',
                              textDecoration: 'none',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              display: 'block',
                            }}
                          >
                            {item.title || item.path}
                          </Link>
                        </div>

                        {/* Reorder buttons */}
                        <div style={{display: 'flex', flexDirection: 'column', gap: 1}}>
                          <button
                            onClick={() => handleMoveItem(list.id, item.path, 'up')}
                            disabled={idx === 0}
                            title="Move up"
                            style={{
                              background: 'none', border: '1px solid var(--ifm-color-emphasis-200)',
                              borderRadius: 3, cursor: idx === 0 ? 'default' : 'pointer',
                              padding: '1px 6px', fontSize: '0.7em', lineHeight: 1.3,
                              color: idx === 0 ? 'var(--ifm-color-emphasis-200)' : 'var(--ifm-color-emphasis-600)',
                            }}
                          >
                            &#9650;
                          </button>
                          <button
                            onClick={() => handleMoveItem(list.id, item.path, 'down')}
                            disabled={idx === list.items.length - 1}
                            title="Move down"
                            style={{
                              background: 'none', border: '1px solid var(--ifm-color-emphasis-200)',
                              borderRadius: 3, cursor: idx === list.items.length - 1 ? 'default' : 'pointer',
                              padding: '1px 6px', fontSize: '0.7em', lineHeight: 1.3,
                              color: idx === list.items.length - 1 ? 'var(--ifm-color-emphasis-200)' : 'var(--ifm-color-emphasis-600)',
                            }}
                          >
                            &#9660;
                          </button>
                        </div>

                        {/* Remove */}
                        <button
                          onClick={() => handleRemoveItem(list.id, item.path)}
                          title="Remove from list"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--ifm-color-emphasis-400)', fontSize: '1em',
                            padding: '2px 4px', lineHeight: 1,
                          }}
                        >
                          &times;
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p style={{
                    textAlign: 'center', color: 'var(--ifm-color-emphasis-400)',
                    fontSize: '0.9em', margin: '8px 0',
                  }}>
                    No items yet. Add papers or doc pages below.
                  </p>
                )}

                {/* Add item toggle */}
                {addingTo === list.id ? (
                  <form
                    onSubmit={(e) => handleAddItem(e, list.id)}
                    style={{
                      marginTop: 12, padding: '12px 14px', borderRadius: 8,
                      border: '1px dashed var(--ifm-color-emphasis-300)',
                      background: 'var(--ifm-color-emphasis-0)',
                    }}
                  >
                    <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8}}>
                      <input
                        type="text"
                        placeholder="Path (e.g., posts/research/paper.md or citationKey)"
                        value={itemPath}
                        onChange={e => setItemPath(e.target.value)}
                        required
                        style={{
                          flex: '1 1 200px', padding: '8px 10px', borderRadius: 6,
                          border: '1px solid var(--ifm-color-emphasis-300)',
                          fontSize: '0.88em', boxSizing: 'border-box',
                          backgroundColor: 'var(--ifm-background-color)',
                          color: 'var(--ifm-font-color-base)',
                        }}
                      />
                      <input
                        type="text"
                        placeholder="Title (optional)"
                        value={itemTitle}
                        onChange={e => setItemTitle(e.target.value)}
                        style={{
                          flex: '1 1 150px', padding: '8px 10px', borderRadius: 6,
                          border: '1px solid var(--ifm-color-emphasis-300)',
                          fontSize: '0.88em', boxSizing: 'border-box',
                          backgroundColor: 'var(--ifm-background-color)',
                          color: 'var(--ifm-font-color-base)',
                        }}
                      />
                    </div>
                    <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
                      <select
                        value={itemType}
                        onChange={e => setItemType(e.target.value)}
                        style={{
                          padding: '8px 10px', borderRadius: 6,
                          border: '1px solid var(--ifm-color-emphasis-300)',
                          fontSize: '0.88em',
                          backgroundColor: 'var(--ifm-background-color)',
                          color: 'var(--ifm-font-color-base)',
                        }}
                      >
                        <option value="doc">Doc Page</option>
                        <option value="reference">Paper / Reference</option>
                      </select>
                      <button
                        type="submit"
                        disabled={addingItem || !itemPath.trim()}
                        style={{
                          padding: '8px 16px', border: 'none', borderRadius: 6,
                          background: addingItem ? 'var(--ifm-color-emphasis-200)' : 'var(--ifm-color-primary)',
                          color: addingItem ? 'var(--ifm-color-emphasis-500)' : '#fff',
                          cursor: addingItem ? 'not-allowed' : 'pointer',
                          fontSize: '0.85em', fontWeight: 600, fontFamily: 'inherit',
                        }}
                      >
                        {addingItem ? 'Adding...' : 'Add'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAddingTo(null); setItemPath(''); setItemTitle(''); setItemType('doc'); }}
                        style={{
                          padding: '8px 12px', border: '1px solid var(--ifm-color-emphasis-300)',
                          borderRadius: 6, background: 'transparent',
                          cursor: 'pointer', fontSize: '0.85em', fontFamily: 'inherit',
                          color: 'var(--ifm-font-color-base)',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    onClick={() => { setAddingTo(list.id); setItemPath(''); setItemTitle(''); setItemType('doc'); }}
                    style={{
                      marginTop: 10, padding: '7px 14px',
                      border: '1px solid var(--ifm-color-emphasis-300)',
                      borderRadius: 6, background: 'transparent',
                      cursor: 'pointer', fontSize: '0.85em', fontFamily: 'inherit',
                      color: 'var(--ifm-color-primary)', fontWeight: 500,
                    }}
                  >
                    + Add Item
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ReadingListsPage() {
  return (
    <Layout title="Reading Lists" description="Curated reading lists of papers and documentation">
      <main>
        <BrowserOnly fallback={
          <div style={{textAlign: 'center', padding: '4rem', color: 'var(--ifm-color-emphasis-500)'}}>
            Loading...
          </div>
        }>
          {() => <ErrorBoundary><ReadingListsApp /></ErrorBoundary>}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
