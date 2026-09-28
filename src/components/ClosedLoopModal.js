import React, { useState } from 'react';

export default function ClosedLoopModal({ feedbackId, data, onDataChange, onClose, fieldMutations }) {
  const feedback = data.feedback.find(f => f.id === feedbackId);
  const existing = data.closedLoop[feedbackId] || {};
  const [form, setForm] = useState({
    howIncorporated: existing.howIncorporated || '',
    communicatedBack: existing.communicatedBack ?? false,
    communicationMethod: existing.communicationMethod || '',
    closedDate: existing.closedDate || new Date().toISOString().slice(0, 10),
    closed: existing.closed || false,
    notes: existing.notes || ''
  });
  const [saving, setSaving] = useState(false);

  function set(field, value) { setForm(f => ({ ...f, [field]: value })); }

  async function handleSave() {
    setSaving(true);
    try {
      await fieldMutations.updateLoop(feedback, form);

      // Log actual open/closed transitions to the shared history feed (same log the Dashboard's
      // "Recent Status Changes" reads) — not every note edit, so the feed reflects real status
      // moves rather than firing on every keystroke-driven save.
      if (Boolean(existing.closed) !== Boolean(form.closed)) {
        const init = data.initiatives.find(i => i.id === feedback.initiativeId);
        const entry = {
          id: `${feedbackId}-${Date.now()}`,
          type: 'loop',
          initiativeId: feedback.initiativeId,
          initiativeName: init?.name,
          providerName: feedback.providerName,
          region: feedback.region,
          summary: (form.howIncorporated || '').slice(0, 140),
          closed: form.closed,
          changedAt: new Date().toISOString()
        };
        onDataChange(current => ({ ...current, timelineHistory: [entry, ...(current.timelineHistory || [])].slice(0, 200) }));
      }
      onClose();
    } finally { setSaving(false); }
  }

  function daysOpen() {
    if (!feedback) return null;
    const start = new Date(feedback.createdAt || feedback.date);
    const end = form.closedDate ? new Date(form.closedDate) : new Date();
    return Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
  }

  if (!feedback) return null;

  return (
    <div style={styles.overlay}>
      <div role="dialog" aria-modal="true" aria-labelledby="closed-loop-title" style={styles.box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 id="closed-loop-title" style={{ color: '#032D60', fontSize: 18, fontWeight: 700 }}>Closed Loop Tracking</h2>
          <button aria-label="Close closed-loop dialog" onClick={onClose} style={styles.ghostBtn}>✕</button>
        </div>

        <div style={styles.infoBox}>
          <strong>{feedback.providerName}</strong> · {feedback.region} · {feedback.date}
          {feedback.initiativeId && (() => {
            const init = data.initiatives.find(i => i.id === feedback.initiativeId);
            return init ? <span> · {init.name}</span> : null;
          })()}
        </div>

        <label style={styles.label}>How was the feedback incorporated?</label>
        <textarea style={styles.textarea} value={form.howIncorporated}
          onChange={e => set('howIncorporated', e.target.value)}
          placeholder="Describe what action was taken (or why no action was taken)..." />

        <label style={styles.label}>Was the result communicated back to the provider?</label>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          {['Yes', 'No', 'Pending'].map(opt => (
            <button key={opt}
              onClick={() => set('communicatedBack', opt)}
              style={{ ...styles.chip, ...(form.communicatedBack === opt ? styles.chipActive : {}) }}>
              {opt}
            </button>
          ))}
        </div>

        {form.communicatedBack === 'Yes' && (
          <>
            <label style={styles.label}>How was it communicated?</label>
            <input style={styles.input} value={form.communicationMethod}
              onChange={e => set('communicationMethod', e.target.value)}
              placeholder="e.g. Slack message, team call, email..." />
          </>
        )}

        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={styles.label}>Loop Closed Date</label>
            <input type="date" style={styles.input} value={form.closedDate}
              onChange={e => set('closedDate', e.target.value)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 12 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>
              {daysOpen() !== null ? `${daysOpen()} days open` : ''}
            </span>
          </div>
        </div>

        <label style={styles.label}>Additional Notes</label>
        <textarea style={{ ...styles.textarea, height: 60 }} value={form.notes}
          onChange={e => set('notes', e.target.value)} />

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={form.closed} onChange={e => set('closed', e.target.checked)}
              style={{ width: 16, height: 16 }} />
            Mark loop as closed
          </label>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={styles.ghostBtn}>Cancel</button>
          <button onClick={handleSave} disabled={saving || fieldMutations.busy || fieldMutations.readOnly} style={styles.primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 },
  box: { background: '#fff', borderRadius: 12, padding: 28, width: 540, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' },
  infoBox: { background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '10px 14px', fontSize: 14, marginBottom: 16, color: '#0369a1' },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 8 },
  input: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 10px', fontSize: 14, marginBottom: 12, outline: 'none' },
  textarea: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 10px', fontSize: 14, marginBottom: 12, outline: 'none', height: 80, resize: 'vertical' },
  chip: { border: '1px solid #d1d5db', borderRadius: 20, padding: '5px 14px', fontSize: 13, cursor: 'pointer', background: '#fff', color: '#374151' },
  chipActive: { background: '#0176D3', color: '#fff', borderColor: '#0176D3' },
  primaryBtn: { background: '#0176D3', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  ghostBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 14 }
};
