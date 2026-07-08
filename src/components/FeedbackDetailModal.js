import React, { useState } from 'react';
import { generateId } from '../data';

export default function FeedbackDetailModal({ feedbackId, data, onDataChange, onClose, onEdit, onEditClosedLoop }) {
  const feedback = data.feedback.find(f => f.id === feedbackId);
  const [newAction, setNewAction] = useState('');

  if (!feedback) return null;

  const initiative = data.initiatives.find(i => i.id === feedback.initiativeId);
  const loopStatus = data.closedLoop[feedbackId];
  const actionItems = feedback.actionItems || [];

  function updateFeedback(patch) {
    onDataChange({
      ...data,
      feedback: data.feedback.map(f => f.id === feedbackId ? { ...f, ...patch } : f)
    });
  }

  function addAction() {
    if (!newAction.trim()) return;
    const item = { id: generateId(), text: newAction.trim(), done: false, createdAt: new Date().toISOString() };
    updateFeedback({ actionItems: [...actionItems, item] });
    setNewAction('');
  }

  function toggleAction(id) {
    updateFeedback({
      actionItems: actionItems.map(a => a.id === id ? { ...a, done: !a.done } : a)
    });
  }

  function deleteAction(id) {
    updateFeedback({ actionItems: actionItems.filter(a => a.id !== id) });
  }

  const openCount = actionItems.filter(a => !a.done).length;

  return (
    <div style={styles.overlay}>
      <div style={styles.box}>

        {/* Header */}
        <div style={styles.header}>
          <div>
            <h2 style={{ color: '#032D60', fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
              {feedback.providerName}
              {feedback.providerRole && <span style={{ fontSize: 14, fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>{feedback.providerRole}</span>}
            </h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Tag>{feedback.region}</Tag>
              {feedback.date && <Tag>{feedback.date}</Tag>}
              {feedback.format && <Tag>{feedback.format}</Tag>}
              {initiative && <Tag blue>{initiative.name}</Tag>}
              {loopStatus?.closed
                ? <Tag green>✓ Loop Closed</Tag>
                : <Tag amber>⚡ Loop Open</Tag>}
            </div>
          </div>
          <button onClick={onClose} style={styles.closeBtn}>✕</button>
        </div>

        {/* Intelligence Captured */}
        {feedback.notes && (
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Intelligence Captured</div>
            <p style={{ fontSize: 14, color: '#1f2937', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{feedback.notes}</p>
          </div>
        )}

        {/* Action Items */}
        <div style={styles.section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={styles.sectionTitle}>
              Action Items
              {actionItems.length > 0 && (
                <span style={{ fontSize: 12, fontWeight: 400, color: openCount > 0 ? '#d97706' : '#059669', marginLeft: 8 }}>
                  {openCount > 0 ? `${openCount} open` : 'all done'}
                </span>
              )}
            </div>
          </div>

          {actionItems.length === 0 && (
            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12 }}>No action items yet.</p>
          )}

          {actionItems.map(a => (
            <div key={a.id} style={{ ...styles.actionRow, opacity: a.done ? 0.5 : 1 }}>
              <input type="checkbox" checked={a.done} onChange={() => toggleAction(a.id)}
                style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#0176D3', flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 14, textDecoration: a.done ? 'line-through' : 'none', color: '#1f2937' }}>
                {a.text}
              </span>
              <button onClick={() => deleteAction(a.id)} style={styles.deleteBtn} title="Remove">✕</button>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input
              style={styles.actionInput}
              value={newAction}
              onChange={e => setNewAction(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addAction()}
              placeholder="Add an action item and press Enter..."
            />
            <button onClick={addAction} style={styles.addBtn}>Add</button>
          </div>
        </div>

        {/* Footer buttons */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={() => { onClose(); onEditClosedLoop(feedbackId); }} style={styles.ghostBtn}>
            {loopStatus?.closed ? 'View Loop' : 'Close Loop'}
          </button>
          <button onClick={() => { onClose(); onEdit(feedback); }} style={styles.ghostBtn}>
            ✎ Edit
          </button>
        </div>

      </div>
    </div>
  );
}

function Tag({ children, blue, green, amber }) {
  const bg = blue ? '#e0f0ff' : green ? '#d1fae5' : amber ? '#fef3c7' : '#f3f4f6';
  const color = blue ? '#0176D3' : green ? '#059669' : amber ? '#d97706' : '#374151';
  return (
    <span style={{ fontSize: 12, background: bg, color, padding: '2px 8px', borderRadius: 10, fontWeight: 500 }}>
      {children}
    </span>
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 400 },
  box: { background: '#fff', borderRadius: 12, width: 620, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', padding: 28 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 12 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af', flexShrink: 0, padding: 4 },
  section: { background: '#f8fafc', borderRadius: 8, padding: 16, marginBottom: 14 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#0176D3', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 },
  actionRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #e5e7eb' },
  actionInput: { flex: 1, border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 10px', fontSize: 14, outline: 'none' },
  addBtn: { background: '#0176D3', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontWeight: 600, cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap' },
  deleteBtn: { background: 'none', border: 'none', color: '#d1d5db', cursor: 'pointer', fontSize: 14, padding: '0 2px', flexShrink: 0 },
  ghostBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
};
