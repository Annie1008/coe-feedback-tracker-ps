import React, { useState } from 'react';
import { generateId } from '../data';

export default function ActionItems({ feedback, data, onDataChange }) {
  const [newAction, setNewAction] = useState('');
  const actionItems = feedback.actionItems || [];

  function updateFeedback(patch) {
    onDataChange({ ...data, feedback: data.feedback.map(f => f.id === feedback.id ? { ...f, ...patch } : f) });
  }

  function addAction() {
    if (!newAction.trim()) return;
    const item = { id: generateId(), text: newAction.trim(), done: false, createdAt: new Date().toISOString() };
    updateFeedback({ actionItems: [...actionItems, item] });
    setNewAction('');
  }

  function toggleAction(id) {
    updateFeedback({ actionItems: actionItems.map(a => a.id === id ? { ...a, done: !a.done } : a) });
  }

  function deleteAction(id) {
    updateFeedback({ actionItems: actionItems.filter(a => a.id !== id) });
  }

  const openCount = actionItems.filter(a => !a.done).length;

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#0176D3', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
        Action Items
        {actionItems.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: 400, color: openCount > 0 ? '#d97706' : '#059669', marginLeft: 8 }}>
            {openCount > 0 ? `${openCount} open` : 'all done'}
          </span>
        )}
      </div>

      {actionItems.length === 0 && (
        <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 8 }}>No action items yet.</p>
      )}

      {actionItems.map(a => (
        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6', opacity: a.done ? 0.5 : 1 }}>
          <input type="checkbox" checked={a.done} onChange={() => toggleAction(a.id)}
            style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#0176D3', flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 13, textDecoration: a.done ? 'line-through' : 'none', color: '#1f2937' }}>{a.text}</span>
          <button onClick={() => deleteAction(a.id)}
            style={{ background: 'none', border: 'none', color: '#d1d5db', cursor: 'pointer', fontSize: 13, padding: 0, flexShrink: 0 }}>✕</button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          style={{ flex: 1, border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 10px', fontSize: 13, outline: 'none' }}
          value={newAction}
          onChange={e => setNewAction(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addAction()}
          placeholder="Add action item and press Enter..."
        />
        <button onClick={addAction}
          style={{ background: '#0176D3', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          Add
        </button>
      </div>
    </div>
  );
}
