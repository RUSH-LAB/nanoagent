import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

const PRIORITY_COLORS = {
  high: {bg: '#fef2f2', border: '#fca5a5', badge: '#ef4444', text: '#991b1b'},
  medium: {bg: '#fffbeb', border: '#fcd34d', badge: '#f59e0b', text: '#92400e'},
  low: {bg: '#f0fdf4', border: '#86efac', badge: '#22c55e', text: '#166534'},
};

const COLUMN_META = {
  todo: {label: 'Todo', color: '#6366f1', bg: '#eef2ff'},
  doing: {label: 'In Progress', color: '#f59e0b', bg: '#fffbeb'},
  done: {label: 'Done', color: '#22c55e', bg: '#f0fdf4'},
};

function TasksApp() {
  const {useState, useEffect, useCallback} = require('react');
  const API_BASE = require('@site/src/utils/api').default;

  const [tasks, setTasks] = useState({todo: [], doing: [], done: []});
  const [counts, setCounts] = useState({todo: 0, doing: 0, done: 0});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formStatus, setFormStatus] = useState('todo');
  const [formPriority, setFormPriority] = useState('medium');
  const [editingTask, setEditingTask] = useState(null);
  const [draggedTask, setDraggedTask] = useState(null);

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tasks`);
      if (res.ok) {
        const data = await res.json();
        setTasks(data.grouped);
        setCounts(data.counts);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [API_BASE]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const createTask = async () => {
    if (!formTitle.trim()) return;
    try {
      await fetch(`${API_BASE}/api/tasks`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({title: formTitle, description: formDesc, status: formStatus, priority: formPriority}),
      });
      setFormTitle(''); setFormDesc(''); setFormStatus('todo'); setFormPriority('medium');
      setShowForm(false);
      loadTasks();
    } catch { /* ignore */ }
  };

  const updateTask = async (id, updates) => {
    try {
      await fetch(`${API_BASE}/api/tasks`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id, ...updates}),
      });
      loadTasks();
    } catch { /* ignore */ }
  };

  const deleteTask = async (id) => {
    if (!confirm('Delete this task?')) return;
    try {
      await fetch(`${API_BASE}/api/tasks`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id}),
      });
      loadTasks();
    } catch { /* ignore */ }
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
    <div style={{maxWidth: 1200, margin: '0 auto', padding: '24px 16px'}}>
      {/* Header */}
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24}}>
        <div>
          <h1 style={{margin: 0, fontSize: 28}}>Task Board</h1>
          <p style={{margin: '4px 0 0', color: '#6b7280', fontSize: 14}}>{totalTasks} task{totalTasks !== 1 ? 's' : ''} total</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditingTask(null); setFormTitle(''); setFormDesc(''); setFormStatus('todo'); setFormPriority('medium'); }}
          style={{
            padding: '10px 20px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8,
            cursor: 'pointer', fontWeight: 600, fontSize: 14,
          }}
        >+ Add Task</button>
      </div>

      {/* Add/Edit Modal */}
      {(showForm || editingTask) && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }} onClick={(e) => { if (e.target === e.currentTarget) { setShowForm(false); cancelEdit(); } }}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 480,
            boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          }}>
            <h3 style={{margin: '0 0 16px', fontSize: 18}}>{editingTask ? 'Edit Task' : 'New Task'}</h3>
            <input
              value={formTitle}
              onChange={e => setFormTitle(e.target.value)}
              placeholder="Task title..."
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
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, alignItems: 'start'}}>
        {statusOrder.map(status => {
          const meta = COLUMN_META[status];
          const columnTasks = tasks[status] || [];
          return (
            <div
              key={status}
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
    <Layout title="Task Board" description="Kanban-style project task board">
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <TasksApp />}
      </BrowserOnly>
    </Layout>
  );
}
