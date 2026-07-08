import React, { useState } from 'react';
import { generateId } from '../data';
import FeedbackForm from './FeedbackForm';
import AIQueryBox from './AIQueryBox';

const COLORS = ['#0176D3','#1B96FF','#0D7DBF','#032D60','#3A3A3A','#107569','#9B3A35','#8A6800'];
const EMPTY_FORM = { name: '', description: '', rolloutDate: '', color: COLORS[0] };

export default function InitiativesView({ data, onDataChange, onSelectInitiative }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showLogFeedback, setShowLogFeedback] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowAdd(true);
  }

  function openEdit(e, init) {
    e.stopPropagation();
    setForm({ name: init.name, description: init.description, rolloutDate: init.rolloutDate || '', color: init.color });
    setEditingId(init.id);
    setShowAdd(true);
  }

  function handleSave() {
    if (!form.name.trim()) return;
    let updated;
    if (editingId) {
      updated = {
        ...data,
        initiatives: data.initiatives.map(i => i.id === editingId ? { ...i, ...form } : i)
      };
    } else {
      updated = {
        ...data,
        initiatives: [...data.initiatives, { ...form, id: generateId() }]
      };
    }
    onDataChange(updated);
    setForm(EMPTY_FORM);
    setShowAdd(false);
    setEditingId(null);
  }

  function handleClose() {
    setShowAdd(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function feedbackCount(initiativeId) {
    return data.feedback.filter(f => f.initiativeId === initiativeId).length;
  }

  function openCount(initiativeId) {
    return data.feedback.filter(f =>
      f.initiativeId === initiativeId && !data.closedLoop[f.id]?.closed
    ).length;
  }

  function enabledOUs(initiativeId) {
    return [...new Set(data.feedback.filter(f => f.initiativeId === initiativeId).map(f => f.region))].length;
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#032D60' }}>CoE Initiatives</h1>
          <p style={{ color: '#6b7280', marginTop: 4 }}>Click an initiative to view field feedback and details.</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setShowLogFeedback(true)} style={styles.feedbackBtn}>📝 Log Field Input</button>
          <button onClick={openAdd} style={styles.primaryBtn}>+ Add Initiative</button>
        </div>
      </div>

      <AIQueryBox data={data} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20 }}>
        {data.initiatives.map(init => (
          <div
            key={init.id}
            onClick={() => onSelectInitiative(init.id)}
            style={{ ...styles.card, borderTop: `4px solid ${init.color}`, cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: init.color }}>{init.name}</h2>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  onClick={e => openEdit(e, init)}
                  title="Edit initiative"
                  style={styles.editBtn}>
                  ✎
                </button>
                <span style={{ ...styles.badge, background: init.color }}>{feedbackCount(init.id)} inputs</span>
              </div>
            </div>
            <p style={{ color: '#6b7280', fontSize: 14, margin: '8px 0 12px' }}>{init.description}</p>
            <div style={{ display: 'flex', gap: 16, fontSize: 13, color: '#374151' }}>
              <span>🗓 {init.rolloutDate || 'TBD'}</span>
              <span>🌍 {enabledOUs(init.id)} OUs</span>
              <span style={{ color: openCount(init.id) > 0 ? '#d97706' : '#059669' }}>
                ⚡ {openCount(init.id)} open
              </span>
            </div>
          </div>
        ))}
      </div>

      {showLogFeedback && (
        <div style={styles.modal}>
          <div style={{ ...styles.modalBox, width: 820, maxHeight: '90vh', overflowY: 'auto' }}>
            <FeedbackForm data={data} onDataChange={onDataChange} onClose={() => setShowLogFeedback(false)} />
          </div>
        </div>
      )}

      {showAdd && (
        <div style={styles.modal}>
          <div style={styles.modalBox}>
            <h2 style={{ marginBottom: 16, color: '#032D60' }}>
              {editingId ? 'Edit Initiative' : 'New Initiative'}
            </h2>
            <label style={styles.label}>Name *</label>
            <input style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Pricing Accelerator" />
            <label style={styles.label}>Description</label>
            <textarea style={{ ...styles.input, height: 72 }} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            <label style={styles.label}>Anticipated Rollout Date</label>
            <input type="date" style={styles.input} value={form.rolloutDate} onChange={e => setForm({ ...form, rolloutDate: e.target.value })} />
            <label style={styles.label}>Color</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {COLORS.map(c => (
                <div key={c} onClick={() => setForm({ ...form, color: c })}
                  style={{ width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                    border: form.color === c ? '3px solid #000' : '2px solid transparent' }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={handleClose} style={styles.ghostBtn}>Cancel</button>
              <button onClick={handleSave} style={styles.primaryBtn}>
                {editingId ? 'Save Changes' : 'Add Initiative'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 10, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' },
  badge: { color: '#fff', fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 12, whiteSpace: 'nowrap' },
  editBtn: { background: 'none', border: '1px solid #e5e7eb', borderRadius: 5, padding: '2px 7px', cursor: 'pointer', fontSize: 14, color: '#6b7280', lineHeight: 1 },
  feedbackBtn: { background: '#107569', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  primaryBtn: { background: '#0176D3', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  ghostBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '8px 18px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modalBox: { background: '#fff', borderRadius: 12, padding: 28, width: 480, maxWidth: '95vw' },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 10px', fontSize: 14, marginBottom: 12, outline: 'none' }
};
