import React, { useState, useMemo } from 'react';
import { REGIONS, formatDate, advisorsForRegion, advisorEmail } from '../data';
import FeedbackForm from './FeedbackForm';
import ActionItems from './ActionItems';
import SendToAdvisorButton from './SendToAdvisorButton';
import { classify, careStatus, CARE_STYLE } from './TimelineView';

function combinedNotes(f) {
  const parts = [];
  if (f.frictionPoints) parts.push(`Friction Points:\n${f.frictionPoints}`);
  if (f.toolsMentioned) parts.push(`Tools Mentioned:\n${f.toolsMentioned}`);
  if (f.workarounds) parts.push(`Workarounds:\n${f.workarounds}`);
  if (f.dealImpact) parts.push(`Deal Impact:\n${f.dealImpact}`);
  if (f.quotes) parts.push(`Direct Quotes:\n${f.quotes}`);
  if (f.notes) parts.push(f.notes);
  return parts.join('\n\n');
}

function exportToCSV(rows, data) {
  const headers = [
    'Date', 'Provider Name', 'Region', 'Initiative', 'Format',
    'Friction Points', 'Tools Mentioned', 'Workarounds', 'Deal Impact',
    'Direct Quotes', 'Notes', 'Loop Closed'
  ];

  function escape(val) {
    if (val == null) return '';
    const str = String(val).replace(/"/g, '""');
    return /[",\n\r]/.test(str) ? `"${str}"` : str;
  }

  function initiativeName(id) {
    const i = data.initiatives.find(x => x.id === id);
    return i ? i.name : '';
  }

  const csvRows = rows.map(f => [
    escape(f.date),
    escape(f.providerName),
    escape(f.region),
    escape(initiativeName(f.initiativeId)),
    escape(f.format),
    escape(f.frictionPoints),
    escape(f.toolsMentioned),
    escape(f.workarounds),
    escape(f.dealImpact),
    escape(f.quotes),
    escape(f.notes),
    escape(data.closedLoop[f.id]?.closed ? 'Yes' : 'No')
  ].join(','));

  const csv = [headers.join(','), ...csvRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `coe-feedback-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function FeedbackTable({ data, onDataChange, onEditClosedLoop, filterInitiativeId, allGroups = [] }) {
  const [search, setSearch] = useState('');
  const [filterRegion, setFilterRegion] = useState('');
  const [filterInit, setFilterInit] = useState(filterInitiativeId || '');
  const [expanded, setExpanded] = useState(null);
  const [editingEntry, setEditingEntry] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // Message the OU/CoE advisor DM button sends — kept in one place so the Slack message and
  // the on-screen status badge can never say something different.
  function advisorMessage(f, item, status) {
    const lines = [
      `Field input from ${f.providerName} (${f.region}, ${formatDate(f.date)})`,
      status ? `Status: ${CARE_STYLE[status].label}${item?.bucketLabel ? ` — ${item.bucketLabel}` : ''}` : 'Status: not yet triaged'
    ];
    return lines.join('\n');
  }

  // Lets each row show the exact same "what's been done" read the Timeline tab shows for the
  // group this entry got merged into (Jira/roadmap/manual-override/fixed, all combined) — so
  // Field Inputs never tells a different story than Timeline for the same underlying group.
  const groupByFeedbackId = useMemo(() => {
    const map = new Map();
    allGroups.forEach(g => g.sourceIds.forEach(id => map.set(id, g)));
    return map;
  }, [allGroups]);
  const feedbackByIdAll = useMemo(() => new Map(data.feedback.map(f => [f.id, f])), [data.feedback]);

  const rows = data.feedback.filter(f => {
    if (filterRegion && f.region !== filterRegion) return false;
    if (filterInit && f.initiativeId !== filterInit) return false;
    if (search) {
      const q = search.toLowerCase();
      return [f.providerName, f.region, f.frictionPoints, f.quotes, f.notes]
        .some(v => v && v.toLowerCase().includes(q));
    }
    return true;
  });

  function initiativeName(id) {
    const i = data.initiatives.find(x => x.id === id);
    return i ? i.name : '—';
  }

  function loopStatus(feedbackId) {
    const cl = data.closedLoop[feedbackId];
    return cl ? cl.closed : null;
  }

  function handleDelete(id) {
    const updated = {
      ...data,
      feedback: data.feedback.filter(f => f.id !== id),
      closedLoop: Object.fromEntries(Object.entries(data.closedLoop).filter(([k]) => k !== id))
    };
    onDataChange(updated);
    setConfirmDeleteId(null);
    if (expanded === id) setExpanded(null);
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#032D60' }}>
          {filterInitiativeId ? 'Initiative Feedback' : 'All Field Inputs'}
          <span style={{ fontSize: 14, fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>({rows.length})</span>
        </h2>
        {rows.length > 0 && (
          <button onClick={() => exportToCSV(rows, data)} style={styles.exportBtn}>
            ⬇ Export CSV ({rows.length})
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <input style={styles.filterInput} placeholder="Search feedback..." value={search} onChange={e => setSearch(e.target.value)} />
        <select style={styles.filterInput} value={filterRegion} onChange={e => setFilterRegion(e.target.value)}>
          <option value="">All Regions</option>
          {REGIONS.map(r => <option key={r}>{r}</option>)}
        </select>
        {!filterInitiativeId && (
          <select style={styles.filterInput} value={filterInit} onChange={e => setFilterInit(e.target.value)}>
            <option value="">All Initiatives</option>
            {data.initiatives.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}
      </div>

      {rows.length === 0 ? (
        <div style={styles.empty}>No feedback entries yet. Use "Log Field Input" to add one.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(f => {
            const closed = loopStatus(f.id);
            const isOpen = expanded === f.id;
            const text = combinedNotes(f);
            const actionItems = f.actionItems || [];
            const openActions = actionItems.filter(a => !a.done).length;
            const cl = data.closedLoop[f.id];
            const group = groupByFeedbackId.get(f.id);
            const item = group
              ? classify(group, feedbackByIdAll, data.jiraIssues || [], data.timelineOverrides || {}, data.fixedGroups || {}, data.manualJiraLinks || {})
              : null;
            const status = item ? careStatus(item) : null;
            const advisors = advisorsForRegion(f.region);
            return (
              <div key={f.id} style={{ ...styles.row, borderLeft: `4px solid ${closed ? '#059669' : '#d97706'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                  onClick={() => setExpanded(isOpen ? null : f.id)}>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{f.providerName}</span>
                    <span style={styles.tag}>{f.region}</span>
                    {f.initiativeId && <span style={{ ...styles.tag, background: '#e0f0ff', color: '#0176D3' }}>{initiativeName(f.initiativeId)}</span>}
                    {f.format && <span style={styles.tag}>{f.format}</span>}
                    <span style={{ fontSize: 13, color: '#6b7280' }}>{formatDate(f.date)}</span>
                    {openActions > 0 && (
                      <span style={{ fontSize: 11, background: '#fef3c7', color: '#d97706', padding: '2px 7px', borderRadius: 10, fontWeight: 600 }}>
                        {openActions} action{openActions > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: closed ? '#059669' : '#d97706' }}>
                      {closed ? '✓ Loop Closed' : '⚡ Open'}
                    </span>
                    <button onClick={e => { e.stopPropagation(); onEditClosedLoop(f.id); }}
                      style={styles.smallBtn}>
                      {closed ? 'View Loop' : 'Close Loop'}
                    </button>
                    <button onClick={e => { e.stopPropagation(); setEditingEntry(f); setExpanded(null); }}
                      style={styles.smallBtn}>
                      ✎ Edit
                    </button>
                    <button onClick={e => { e.stopPropagation(); setConfirmDeleteId(f.id); }}
                      style={styles.deleteBtn}>
                      🗑
                    </button>
                    <span style={{ color: '#9ca3af', fontSize: 18 }}>{isOpen ? '▲' : '▼'}</span>
                  </div>
                </div>

                {item && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, borderRadius: 12, padding: '3px 10px',
                      color: CARE_STYLE[status].color, background: CARE_STYLE[status].background,
                      border: `1px solid ${CARE_STYLE[status].border}`
                    }}>
                      {CARE_STYLE[status].label}
                    </span>
                    {status !== 'not-addressed' && item.bucketLabel && (
                      <span style={{ fontSize: 11, color: '#6b7280' }}>📅 {item.bucketLabel}</span>
                    )}
                    {item.source.type === 'jira' && (
                      <span style={{ fontSize: 11, color: '#6b7280' }} title={item.source.jiraMatch.summary}>
                        🎫 {item.source.jiraMatch.key}
                      </span>
                    )}
                  </div>
                )}
                {closed && cl?.howIncorporated && (
                  <p style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
                    <strong>How incorporated:</strong> {cl.howIncorporated}
                  </p>
                )}
                {advisors.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: '#6b7280' }}>Owner: {advisors.join(', ')}</span>
                    {advisors.map(name => (
                      <SendToAdvisorButton key={name} advisorName={name} email={advisorEmail(name, data.advisorEmails)} message={advisorMessage(f, item, status)} />
                    ))}
                  </div>
                )}

                {isOpen && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #e5e7eb' }}>
                    {text ? (
                      <p style={{ fontSize: 14, color: '#1f2937', whiteSpace: 'pre-wrap', lineHeight: 1.6, marginBottom: 14 }}>{text}</p>
                    ) : (
                      <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 14 }}>No notes captured.</p>
                    )}
                    <ActionItems feedback={f} data={data} onDataChange={onDataChange} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit modal */}
      {editingEntry && (
        <div style={styles.modal}>
          <div style={{ ...styles.modalBox }}>
            <FeedbackForm
              data={data}
              onDataChange={onDataChange}
              editEntry={editingEntry}
              onClose={() => setEditingEntry(null)}
            />
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDeleteId && (
        <div style={styles.modal}>
          <div style={{ ...styles.modalBox, maxWidth: 400, padding: 28 }}>
            <h3 style={{ color: '#032D60', marginBottom: 8 }}>Delete this feedback?</h3>
            <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 20 }}>
              This cannot be undone. Any closed loop data for this entry will also be removed.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDeleteId(null)} style={styles.ghostBtn}>Cancel</button>
              <button onClick={() => handleDelete(confirmDeleteId)} style={styles.confirmDeleteBtn}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  filterInput: { border: '1px solid #d1d5db', borderRadius: 6, padding: '7px 10px', fontSize: 14, outline: 'none', minWidth: 160 },
  row: { background: '#fff', borderRadius: 8, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
  tag: { fontSize: 12, background: '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: 10, fontWeight: 500 },
  smallBtn: { fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#fff', whiteSpace: 'nowrap' },
  deleteBtn: { fontSize: 13, border: '1px solid #fecaca', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', background: '#fff', color: '#dc2626' },
  empty: { background: '#fff', borderRadius: 8, padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 15 },
  modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 },
  modalBox: { background: '#fff', borderRadius: 12, width: 820, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' },
  exportBtn: { background: '#032D60', color: '#fff', border: 'none', padding: '7px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' },
  ghostBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
  confirmDeleteBtn: { background: '#dc2626', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 }
};
