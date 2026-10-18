import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import pageStyles from '@site/src/css/page.module.css';
import {clientPlatform} from '@site/src/platform/client';

const PRIORITY_COLORS = {
  high: {border: '#fca5a5', badge: '#ef4444'},
  medium: {border: '#fcd34d', badge: '#f59e0b'},
  low: {border: '#86efac', badge: '#22c55e'},
};

const COLUMN_META = {
  todo: {label: 'Todo', color: '#6366f1', bg: '#eef2ff'},
  doing: {label: 'In Progress', color: '#f59e0b', bg: '#fffbeb'},
  done: {label: 'Done', color: '#22c55e', bg: '#f0fdf4'},
};

function TasksApp() {
  const {useState, useEffect, useCallback} = require('react');
  const { default: API_BASE, apiFetch } = require('@site/src/utils/api');

  const [tasks, setTasks] = useState({todo: [], doing: [], done: []});
  const [counts, setCounts] = useState({todo: 0, doing: 0, done: 0});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formStatus, setFormStatus] = useState('todo');
  const [formPriority, setFormPriority] = useState('medium');
  const [editingTask, setEditingTask] = useState(null);
  const [draggedTask, setDraggedTask] = useState(null);

  const loadTasks = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/tasks`);
      if (!res.ok) throw new Error(`Failed to load tasks (${res.status})`);
      const data = await res.json();
      setTasks(data.grouped);
      setCounts(data.counts);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [API_BASE]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const createTask = async () => {
    if (!formTitle.trim()) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/tasks`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({title: formTitle, description: formDesc, status: formStatus, priority: formPriority}),
      });
      if (!res.ok) throw new Error(`Failed to create task (${res.status})`);
      setFormTitle(''); setFormDesc(''); setFormStatus('todo'); setFormPriority('medium');
      setShowForm(false);
      loadTasks();
    } catch (err) {
      setError(err.message);
    }
  };

  const updateTask = async (id, updates) => {
    try {
      const res = await apiFetch(`${API_BASE}/api/tasks`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id, ...updates}),
      });
      if (!res.ok) throw new Error(`Failed to update task (${res.status})`);
      loadTasks();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteTask = async (id) => {
    if (!(await clientPlatform.dialogs.confirm('Delete this task?'))) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/tasks`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id}),
      });
      if (!res.ok) throw new Error(`Failed to delete task (${res.status})`);
      loadTasks();
    } catch (err) {
      setError(err.message);
    }
  };

  const moveTask = (task, newStatus) => {
    if (task.status === newStatus) return;
    updateTask(task.id, {status: newStatus});
  };

  const startEdit = (task) => {
    setEditingTask(task);
    setFormTitle(task.title);
    setFormDesc(task.description || '');
    setFormPriority(task.priority || 'medium');
  };

  const saveEdit = async () => {
    if (!editingTask || !formTitle.trim()) return;
    await updateTask(editingTask.id, {title: formTitle, description: formDesc, priority: formPriority});
    setEditingTask(null);
    setFormTitle(''); setFormDesc(''); setFormPriority('medium');
  };

  const cancelEdit = () => {
    setEditingTask(null);
    setFormTitle(''); setFormDesc(''); setFormPriority('medium');
  };

  // Drag handlers
  const handleDragStart = (e, task) => {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.style.opacity = '0.5';
  };

  const handleDragEnd = (e) => {
    e.currentTarget.style.opacity = '1';
    setDraggedTask(null);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e, targetStatus) => {
    e.preventDefault();
    if (draggedTask && draggedTask.status !== targetStatus) {
      moveTask(draggedTask, targetStatus);
    }
    setDraggedTask(null);
  };

  const statusOrder = ['todo', 'doing', 'done'];
  const prevStatus = (s) => statusOrder[Math.max(0, statusOrder.indexOf(s) - 1)];
  const nextStatus = (s) => statusOrder[Math.min(statusOrder.length - 1, statusOrder.indexOf(s) + 1)];

  if (loading) {
    return <div style={{padding: 40, textAlign: 'center', color: '#6b7280'}}>Loading tasks...</div>;
  }

  const totalTasks = counts.todo + counts.doing + counts.done;

  return (
    <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`} role="main" aria-label="Task board">
      {/* Header */}
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24}}>
        <div>
          <h1 style={{margin: 0, fontSize: 28}}>Task Board</h1>
          <p style={{margin: '4px 0 0', color: '#6b7280', fontSize: 14}} aria-live="polite">{totalTasks} task{totalTasks !== 1 ? 's' : ''} total</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditingTask(null); setFormTitle(''); setFormDesc(''); setFormStatus('todo'); setFormPriority('medium'); }}
          aria-label="Add new task"
          style={{
            padding: '10px 20px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8,
            cursor: 'pointer', fontWeight: 600, fontSize: 14,
          }}
        >+ Add Task</button>
      </div>

      {/* Error display */}
      {error && (
        <div role="alert" style={{
          padding: '12px 16px', borderRadius: 8, marginBottom: 16,
          background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 14,
        }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" style={{
            background: 'none', border: 'none', cursor: 'pointer', color: '#991b1b',
            fontSize: 18, lineHeight: 1, padding: '0 4px',
          }}>&times;</button>
        </div>
      )}

      {/* Add/Edit Modal */}
      {(showForm || editingTask) && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }} role="presentation"
        onClick={(e) => { if (e.target === e.currentTarget) { setShowForm(false); cancelEdit(); } }}
        onKeyDown={(e) => { if (e.key === 'Escape') { setShowForm(false); cancelEdit(); } }}
        >
          <div role="dialog" aria-modal="true" aria-label={editingTask ? 'Edit task' : 'Create new task'} style={{
            background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 480,
            boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          }}>
            <h3 style={{margin: '0 0 16px', fontSize: 18}}>{editingTask ? 'Edit Task' : 'New Task'}</h3>
            <input
              value={formTitle}
              onChange={e => setFormTitle(e.target.value)}
              placeholder="Task title..."
              aria-label="Task title"
              autoFocus
              style={{
                width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8,
                fontSize: 14, marginBottom: 12, boxSizing: 'border-box',
              }}
              onKeyDown={e => { if (e.key === 'Enter') editingTask ? saveEdit() : createTask(); }}
            />
            <textarea
              value={formDesc}
              onChange={e => setFormDesc(e.target.value)}
              placeholder="Description (optional)..."
              aria-label="Task description"
              rows={3}
              style={{
                width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8,
                fontSize: 14, marginBottom: 12, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit',
              }}
            />
            <div style={{display: 'flex', gap: 12, marginBottom: 16}}>
              {!editingTask && (
                <div style={{flex: 1}}>
                  <label style={{display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 4}}>Status</label>
                  <select
                    value={formStatus}
                    onChange={e => setFormStatus(e.target.value)}
                    style={{width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14}}
                  >
                    <option value="todo">Todo</option>
                    <option value="doing">In Progress</option>
                    <option value="done">Done</option>
                  </select>
                </div>
              )}
              <div style={{flex: 1}}>
                <label style={{display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 4}}>Priority</label>
                <select
                  value={formPriority}
                  onChange={e => setFormPriority(e.target.value)}
                  style={{width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14}}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
            <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
              <button
                onClick={() => { setShowForm(false); cancelEdit(); }}
                style={{padding: '8px 16px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 14}}
              >Cancel</button>
              <button
                onClick={editingTask ? saveEdit : createTask}
                disabled={!formTitle.trim()}
                style={{
                  padding: '8px 16px', background: formTitle.trim() ? '#6366f1' : '#c7d2fe', color: '#fff',
                  border: 'none', borderRadius: 6, cursor: formTitle.trim() ? 'pointer' : 'not-allowed',
                  fontWeight: 600, fontSize: 14,
                }}
              >{editingTask ? 'Save' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Kanban Columns */}
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, alignItems: 'start'}} role="region" aria-label="Kanban board">
        {statusOrder.map(status => {
          const meta = COLUMN_META[status];
          const columnTasks = tasks[status] || [];
          return (
            <div
              key={status}
              role="region"
              aria-label={`${meta.label} column, ${columnTasks.length} task${columnTasks.length !== 1 ? 's' : ''}`}
              onDragOver={handleDragOver}
              onDrop={e => handleDrop(e, status)}
              style={{
                background: meta.bg, borderRadius: 12, padding: 16, minHeight: 200,
                border: draggedTask && draggedTask.status !== status ? `2px dashed ${meta.color}` : '2px solid transparent',
                transition: 'border 0.2s',
              }}
            >
              {/* Column Header */}
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  <div style={{width: 10, height: 10, borderRadius: '50%', background: meta.color}} />
                  <span style={{fontWeight: 700, fontSize: 15}}>{meta.label}</span>
                </div>
                <span style={{
                  background: meta.color, color: '#fff', borderRadius: 12, padding: '2px 10px',
                  fontSize: 12, fontWeight: 700, minWidth: 20, textAlign: 'center',
                }}>{columnTasks.length}</span>
              </div>

              {/* Task Cards */}
              {columnTasks.map(task => {
                const pc = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.medium;
                return (
                  <div
                    key={task.id}
                    role="article"
                    aria-label={`${task.title}, ${task.priority} priority`}
                    draggable
                    onDragStart={e => handleDragStart(e, task)}
                    onDragEnd={handleDragEnd}
                    style={{
                      background: '#fff', borderRadius: 8, padding: 12, marginBottom: 8,
                      border: `1px solid ${pc.border}`, boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                      cursor: 'grab', transition: 'box-shadow 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06)'}
                  >
                    <div style={{display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 8}}>
                      <span style={{fontWeight: 600, fontSize: 14, flex: 1, wordBreak: 'break-word'}}>{task.title}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px',
                        borderRadius: 4, background: pc.badge, color: '#fff', flexShrink: 0,
                      }}>{task.priority}</span>
                    </div>
                    {task.description && (
                      <p style={{margin: '6px 0 0', fontSize: 12, color: '#6b7280', lineHeight: 1.4, wordBreak: 'break-word'}}>{task.description}</p>
                    )}
                    {/* Move buttons + actions */}
                    <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10}}>
                      <div style={{display: 'flex', gap: 4}}>
                        {status !== 'todo' && (
                          <button
                            onClick={() => moveTask(task, prevStatus(status))}
                            title={`Move to ${COLUMN_META[prevStatus(status)].label}`}
                            aria-label={`Move "${task.title}" to ${COLUMN_META[prevStatus(status)].label}`}
                            style={{
                              padding: '3px 8px', fontSize: 11, background: '#f3f4f6', border: '1px solid #e5e7eb',
                              borderRadius: 4, cursor: 'pointer', color: '#374151',
                            }}
                          >&larr;</button>
                        )}
                        {status !== 'done' && (
                          <button
                            onClick={() => moveTask(task, nextStatus(status))}
                            title={`Move to ${COLUMN_META[nextStatus(status)].label}`}
                            aria-label={`Move "${task.title}" to ${COLUMN_META[nextStatus(status)].label}`}
                            style={{
                              padding: '3px 8px', fontSize: 11, background: '#f3f4f6', border: '1px solid #e5e7eb',
                              borderRadius: 4, cursor: 'pointer', color: '#374151',
                            }}
                          >&rarr;</button>
                        )}
                      </div>
                      <div style={{display: 'flex', gap: 4}}>
                        <button
                          onClick={() => startEdit(task)}
                          title="Edit task"
                          style={{
                            padding: '3px 8px', fontSize: 11, background: '#eef2ff', border: '1px solid #c7d2fe',
                            borderRadius: 4, cursor: 'pointer', color: '#4338ca',
                          }}
                        >Edit</button>
                        <button
                          onClick={() => deleteTask(task.id)}
                          title="Delete task"
                          style={{
                            padding: '3px 8px', fontSize: 11, background: '#fef2f2', border: '1px solid #fecaca',
                            borderRadius: 4, cursor: 'pointer', color: '#dc2626',
                          }}
                        >Del</button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {columnTasks.length === 0 && (
                <div style={{
                  textAlign: 'center', color: '#9ca3af', fontSize: 13, padding: '24px 0',
                  borderRadius: 8, border: '1px dashed #d1d5db',
                }}>No tasks</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function TasksPage() {
  return (
    <Layout title="Tasks" description="Kanban-style project task board">
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary><TasksApp /></ErrorBoundary>}
      </BrowserOnly>
    </Layout>
  );
}
