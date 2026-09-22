import React from 'react';

export default function DumpedFeedbackPanel({ dumped, onRestore }) {
  const entries = Object.values(dumped || {}).sort((a, b) => new Date(b.dumpedAt) - new Date(a.dumpedAt));

  if (entries.length === 0) {
    return <div style={styles.empty}>Nothing dumped yet. Use "🗑 Not Needed" on a Timeline card to move it here.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {entries.map(e => (
        <div key={e.groupKey} style={styles.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <p style={styles.summary}>{e.summary}</p>
            <button onClick={() => onRestore(e.groupKey)} style={styles.restoreBtn}>↩ Restore</button>
          </div>
          <div style={styles.meta}>
            {e.sourceIds?.length || 0} report{(e.sourceIds?.length || 0) !== 1 ? 's' : ''} · was in "{e.from || 'Not yet scheduled'}" · dumped {new Date(e.dumpedAt).toLocaleDateString()}
          </div>
        </div>
      ))}
    </div>
  );
}

const styles = {
  empty: { color: '#9ca3af', fontSize: 14, padding: '24px 0', textAlign: 'center' },
  card: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 14px' },
  summary: { fontSize: 13, color: '#1f2937', lineHeight: 1.4, margin: 0 },
  meta: { fontSize: 11.5, color: '#6b7280', marginTop: 6 },
  restoreBtn: { fontSize: 11, fontWeight: 600, color: '#0176D3', background: '#fff', border: '1px solid #bfdbfe', borderRadius: 5, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }
};
