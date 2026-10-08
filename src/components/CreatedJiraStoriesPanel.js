import React from 'react';

export default function CreatedJiraStoriesPanel({ links }) {
  const entries = Object.values(links || {}).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (entries.length === 0) {
    return <div style={styles.empty}>No Jira stories created or linked yet. Use "+ Create Jira Story" or accept an AI match suggestion on a Timeline card with no matching ticket.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {entries.map(e => (
        <div key={`${e.groupKey}-${e.key}`} style={styles.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <p style={styles.summary}>{e.summary}</p>
            <a href={e.url} target="_blank" rel="noopener noreferrer" style={styles.openBtn}>{e.key} ↗</a>
          </div>
          <div style={styles.meta}>
            {e.sourceIds?.length || 0} report{(e.sourceIds?.length || 0) !== 1 ? 's' : ''} · {e.linked ? 'linked' : 'created'} {new Date(e.createdAt).toLocaleDateString()}
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
  openBtn: { fontSize: 11, fontWeight: 600, color: '#0176D3', background: '#fff', border: '1px solid #bfdbfe', borderRadius: 5, padding: '4px 10px', textDecoration: 'none', whiteSpace: 'nowrap', flexShrink: 0 }
};
