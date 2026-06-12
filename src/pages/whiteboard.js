import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';

const COLORS = ['#fef3c7', '#dbeafe', '#dcfce7', '#fce7f3', '#e0e7ff', '#fef9c3', '#fed7aa', '#d1fae5'];

function WhiteboardApp() {
  const {useState, useEffect, useRef, useCallback} = require('react');
  const API_BASE = require('@site/src/utils/api').default;

  const canvasRef = useRef(null);
  const [elements, setElements] = useState([]);
  const [boardId, setBoardId] = useState('default');
  const [boards, setBoards] = useState([]);
  const [dragging, setDragging] = useState(null); // {index, offsetX, offsetY, moved}
  const [editing, setEditing] = useState(null); // index
  const [editText, setEditText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newBoardName, setNewBoardName] = useState('');
  const [selectedColor, setSelectedColor] = useState(COLORS[0]);
  const [error, setError] = useState(null);

  const loadBoard = useCallback(async (id) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/whiteboard?id=${encodeURIComponent(id)}`);
      if (res.ok) {
        const data = await res.json();
        setElements(data.whiteboard.elements || []);
      } else if (res.status === 404) {
        setElements([]);
      } else {
        throw new Error(`Failed to load whiteboard (${res.status})`);
      }
    } catch (err) {
      setElements([]);
      setError('Failed to load whiteboard: ' + (err.message || 'Unknown error'));
    }
    setDirty(false);
    setLoading(false);
  }, [API_BASE]);

  const loadBoards = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/whiteboards`);
      if (res.ok) {
        const data = await res.json();
        setBoards(data.whiteboards || []);
      } else {
        console.warn('Failed to load whiteboard list:', res.status);
      }
    } catch (err) {
      console.warn('Failed to load whiteboard list:', err.message);
    }
  }, [API_BASE]);

  useEffect(() => {
    loadBoards();
    loadBoard(boardId);
  }, [loadBoards, loadBoard, boardId]);

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#f9fafb';
    ctx.fillRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);

    // Grid dots
    ctx.fillStyle = '#e5e7eb';
    for (let x = 20; x < canvas.offsetWidth; x += 40) {
      for (let y = 20; y < canvas.offsetHeight; y += 40) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw elements
    elements.forEach((el, i) => {
      const w = el.w || 160;
      const h = el.h || 100;

      // Shadow
      ctx.shadowColor = 'rgba(0,0,0,0.1)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;

      // Note background
      ctx.fillStyle = el.color || '#fef3c7';
      ctx.beginPath();
      ctx.roundRect(el.x, el.y, w, h, 6);
      ctx.fill();

      // Reset shadow
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // Border
      ctx.strokeStyle = editing === i ? '#3b82f6' : 'rgba(0,0,0,0.08)';
      ctx.lineWidth = editing === i ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(el.x, el.y, w, h, 6);
      ctx.stroke();

      // Text
      ctx.fillStyle = '#1f2937';
      ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textBaseline = 'top';
      const text = el.text || '';
      const lines = wrapText(ctx, text, w - 16);
      lines.forEach((line, li) => {
        if (li < Math.floor((h - 16) / 18)) {
          ctx.fillText(line, el.x + 8, el.y + 10 + li * 18);
        }
      });
    });
  }, [elements, editing]);

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  function getElementAt(x, y) {
    // Iterate in reverse so topmost element is found first
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      const w = el.w || 160;
      const h = el.h || 100;
      if (x >= el.x && x <= el.x + w && y >= el.y && y <= el.y + h) {
        return i;
      }
    }
    return -1;
  }

  function handleCanvasMouseDown(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const idx = getElementAt(x, y);

    if (idx >= 0) {
      const el = elements[idx];
      setDragging({index: idx, offsetX: x - el.x, offsetY: y - el.y, moved: false});
      setEditing(null);
    }
  }

  function handleCanvasMouseMove(e) {
    if (!dragging) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const newEls = [...elements];
    newEls[dragging.index] = {
      ...newEls[dragging.index],
      x: Math.max(0, x - dragging.offsetX),
      y: Math.max(0, y - dragging.offsetY),
    };
    setElements(newEls);
    setDirty(true);
    setDragging({...dragging, moved: true});
  }

  function handleCanvasMouseUp() {
    if (dragging && !dragging.moved) {
      // Click without drag => edit
      setEditing(dragging.index);
      setEditText(elements[dragging.index].text || '');
    }
    setDragging(null);
  }

  function handleCanvasDoubleClick(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const idx = getElementAt(x, y);

    if (idx >= 0) {
      setEditing(idx);
      setEditText(elements[idx].text || '');
      return;
    }

    // Add new note
    const newEl = {
      type: 'note',
      x: Math.max(0, x - 80),
      y: Math.max(0, y - 50),
      w: 160,
      h: 100,
      text: '',
      color: selectedColor,
    };
    setElements(prev => [...prev, newEl]);
    setEditing(elements.length);
    setEditText('');
    setDirty(true);
  }

  function handleEditSave() {
    if (editing === null) return;
    const newEls = [...elements];
    newEls[editing] = {...newEls[editing], text: editText};
    setElements(newEls);
    setEditing(null);
    setDirty(true);
  }

  function handleEditDelete() {
    if (editing === null) return;
    setElements(prev => prev.filter((_, i) => i !== editing));
    setEditing(null);
    setDirty(true);
  }

  function handleEditColor(color) {
    if (editing === null) return;
    const newEls = [...elements];
    newEls[editing] = {...newEls[editing], color};
    setElements(newEls);
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`${API_BASE}/api/whiteboard`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: boardId, elements}),
      });
      setDirty(false);
      loadBoards();
    } catch (err) {
      setError('Failed to save whiteboard: ' + (err.message || 'Unknown error'));
    }
    setSaving(false);
  }

  async function handleDeleteBoard() {
    if (!confirm('Delete this whiteboard?')) return;
    try {
      await fetch(`${API_BASE}/api/whiteboard?id=${encodeURIComponent(boardId)}`, {method: 'DELETE'});
      setElements([]);
      setDirty(false);
      loadBoards();
    } catch (err) {
      setError('Failed to delete whiteboard: ' + (err.message || 'Unknown error'));
    }
  }

  function handleCreateBoard(e) {
    e.preventDefault();
    const name = newBoardName.trim();
    if (!name) return;
    setBoardId(name);
    setNewBoardName('');
  }

  if (loading) {
    return (
      <div style={{display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh'}}>
        <p style={{color: '#6b7280'}}>Loading whiteboard...</p>
      </div>
    );
  }

  return (
    <div style={{display: 'flex', flexDirection: 'column', height: 'calc(100vh - 60px)'}} role="main" aria-label="Whiteboard application">
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px',
        borderBottom: '1px solid #e5e7eb', background: '#fff', flexWrap: 'wrap',
      }} role="toolbar" aria-label="Whiteboard tools">
        <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
          <label style={{fontWeight: 600, fontSize: 14, color: '#374151'}}>Board:</label>
          <select
            value={boardId}
            onChange={e => setBoardId(e.target.value)}
            style={{padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13}}
          >
            <option value="default">default</option>
            {boards.filter(b => b.id !== 'default').map(b => (
              <option key={b.id} value={b.id}>{b.id}</option>
            ))}
          </select>
        </div>

        <form onSubmit={handleCreateBoard} style={{display: 'flex', gap: 4}}>
          <input
            type="text"
            placeholder="New board name"
            aria-label="New board name"
            value={newBoardName}
            onChange={e => setNewBoardName(e.target.value)}
            style={{padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13, width: 140}}
          />
          <button type="submit" aria-label="Create new board" style={{
            padding: '4px 10px', borderRadius: 4, border: '1px solid #d1d5db',
            background: '#f9fafb', cursor: 'pointer', fontSize: 13,
          }}>+</button>
        </form>

        <div style={{display: 'flex', gap: 4, marginLeft: 8}} role="group" aria-label="Note color picker">
          {COLORS.map((c, i) => (
            <button
              key={c}
              onClick={() => setSelectedColor(c)}
              title={c}
              aria-label={`Select note color ${i + 1}${selectedColor === c ? ' (selected)' : ''}`}
              aria-pressed={selectedColor === c}
              style={{
                width: 20, height: 20, borderRadius: '50%', border: selectedColor === c ? '2px solid #3b82f6' : '1px solid #d1d5db',
                background: c, cursor: 'pointer', padding: 0,
              }}
            />
          ))}
        </div>

        <div style={{marginLeft: 'auto', display: 'flex', gap: 8}}>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            style={{
              padding: '5px 16px', borderRadius: 6, border: 'none',
              background: dirty ? '#3b82f6' : '#e5e7eb', color: dirty ? '#fff' : '#9ca3af',
              cursor: dirty ? 'pointer' : 'default', fontSize: 13, fontWeight: 500,
            }}
          >
            {saving ? 'Saving...' : dirty ? 'Save' : 'Saved'}
          </button>
          <button
            onClick={handleDeleteBoard}
            aria-label="Delete this whiteboard"
            style={{
              padding: '5px 12px', borderRadius: 6, border: '1px solid #fca5a5',
              background: '#fff', color: '#ef4444', cursor: 'pointer', fontSize: 13,
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div role="alert" style={{
          padding: '8px 16px', background: '#fef2f2', border: '1px solid #fca5a5',
          color: '#991b1b', fontSize: 13, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" style={{
            background: 'none', border: 'none', cursor: 'pointer', color: '#991b1b',
            fontSize: 16, lineHeight: 1, padding: '0 4px',
          }}>&times;</button>
        </div>
      )}

      {/* Canvas area */}
      <div style={{flex: 1, position: 'relative', overflow: 'hidden'}}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Whiteboard "${boardId}" with ${elements.length} sticky note${elements.length !== 1 ? 's' : ''}. Double-click to add a note, click and drag to move notes.`}
          tabIndex={0}
          style={{width: '100%', height: '100%', cursor: dragging ? 'grabbing' : 'crosshair'}}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={handleCanvasMouseUp}
          onDoubleClick={handleCanvasDoubleClick}
        />
        {/* Screen reader summary of notes */}
        <div className="sr-only" aria-live="polite" style={{position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap'}}>
          {elements.length === 0
            ? 'Whiteboard is empty. Double-click to add a sticky note.'
            : `${elements.length} note${elements.length !== 1 ? 's' : ''} on the whiteboard: ${elements.map((el, i) => el.text || `Note ${i + 1} (empty)`).join('; ')}`
          }
        </div>

        {/* Edit overlay */}
        {editing !== null && elements[editing] && (
          <div style={{
            position: 'absolute',
            left: elements[editing].x,
            top: elements[editing].y,
            width: (elements[editing].w || 160) + 40,
            zIndex: 10,
          }}>
            <div style={{
              background: '#fff', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
              padding: 12, border: '1px solid #e5e7eb',
            }}>
              <textarea
                autoFocus
                value={editText}
                onChange={e => setEditText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleEditSave();
                  if (e.key === 'Escape') setEditing(null);
                }}
                rows={3}
                aria-label="Edit note text"
                style={{
                  width: '100%', padding: 8, borderRadius: 4, border: '1px solid #d1d5db',
                  resize: 'vertical', fontSize: 13, fontFamily: 'inherit',
                }}
                placeholder="Type your note..."
              />
              <div style={{display: 'flex', gap: 4, marginTop: 8}} role="group" aria-label="Change note color">
                {COLORS.map((c, i) => (
                  <button
                    key={c}
                    onClick={() => handleEditColor(c)}
                    aria-label={`Color ${i + 1}${(elements[editing]?.color || '#fef3c7') === c ? ' (current)' : ''}`}
                    aria-pressed={(elements[editing]?.color || '#fef3c7') === c}
                    style={{
                      width: 18, height: 18, borderRadius: '50%', padding: 0, cursor: 'pointer',
                      border: (elements[editing]?.color || '#fef3c7') === c ? '2px solid #3b82f6' : '1px solid #ccc',
                      background: c,
                    }}
                  />
                ))}
              </div>
              <div style={{display: 'flex', gap: 6, marginTop: 8}}>
                <button
                  onClick={handleEditSave}
                  style={{
                    padding: '4px 12px', borderRadius: 4, border: 'none',
                    background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: 12,
                  }}
                >Save (Cmd+Enter)</button>
                <button
                  onClick={handleEditDelete}
                  style={{
                    padding: '4px 12px', borderRadius: 4, border: '1px solid #fca5a5',
                    background: '#fff', color: '#ef4444', cursor: 'pointer', fontSize: 12,
                  }}
                >Delete</button>
                <button
                  onClick={() => setEditing(null)}
                  style={{
                    padding: '4px 12px', borderRadius: 4, border: '1px solid #d1d5db',
                    background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 12,
                  }}
                >Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Hint */}
        {elements.length === 0 && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            textAlign: 'center', color: '#9ca3af', pointerEvents: 'none',
          }}>
            <p style={{fontSize: 18, margin: 0}}>Double-click anywhere to add a sticky note</p>
            <p style={{fontSize: 13, marginTop: 4}}>Drag notes to move them</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function WhiteboardPage() {
  return (
    <Layout title="Whiteboard" description="Collaborative brainstorming whiteboard">
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary><WhiteboardApp /></ErrorBoundary>}
      </BrowserOnly>
    </Layout>
  );
}
