import React, { useMemo, useState } from 'react';
import { dedupeFeedback, PODS } from './FeedbackAnalysisPanel';

const TRIAGE_KEY = 'triage';

const STATUSES = ['Not Started', 'In Progress', 'Completed'];
const STATUS_COLORS = { 'Not Started': '#9ca3af', 'In Progress': '#d97706', 'Completed': '#059669' };

// podNotes entries used to be a plain string (just the note text). Normalize old and new
// shapes here so notes saved before status tracking (and later, assignee) existed don't
// break or get lost.
function normalizeEntry(raw) {
  if (!raw) return { note: '', status: 'Not Started', assignee: '' };
  if (typeof raw === 'string') return { note: raw, status: 'Not Started', assignee: '' };
  return { note: raw.note || '', status: raw.status || 'Not Started', assignee: raw.assignee || '' };
}

function podByKey(key) {
  return PODS.find(p => p.key === key) || null;
}

function podPeople(pod) {
  return [pod.lead, ...pod.members];
}

export default function PodTrackerPanel({ feedback, data, onDataChange, initiative }) {
  const [activeBucket, setActiveBucket] = useState(PODS[0].key);
  const groups = useMemo(() => dedupeFeedback(feedback), [feedback]);
  const negative = groups.filter(g => g.sentiment === 'Negative');
  const podNotes = data.podNotes || {};
  const podAssignments = data.podAssignments || {};

  const buckets = useMemo(() => {
    const map = new Map();
    PODS.forEach(pod => map.set(pod.key, { pod, groups: [] }));
    map.set(TRIAGE_KEY, { pod: null, groups: [] });
    negative.forEach(g => {
      // A manual reassignment always wins over the auto keyword match, and forces a
      // single bucket (auto-detection can tie between pods; a human pick doesn't).
      const override = podAssignments[g.groupKey];
      if (override) {
        const target = override === TRIAGE_KEY ? TRIAGE_KEY : (podByKey(override) ? override : null);
        if (target) { map.get(target).groups.push(g); return; }
      }
      if (g.pods.length === 0) {
        map.get(TRIAGE_KEY).groups.push(g);
      } else {
        g.pods.forEach(pod => map.get(pod.key).groups.push(g));
      }
    });
    return Array.from(map.values());
  }, [negative, podAssignments]);

  const bucketStats = useMemo(() => buckets.map(bucket => {
    const counts = { 'Not Started': 0, 'In Progress': 0, 'Completed': 0 };
    bucket.groups.forEach(g => { counts[normalizeEntry(podNotes[g.groupKey]).status]++; });
    return { bucket, counts, total: bucket.groups.length };
  }), [buckets, podNotes]);

  function saveNote(groupKey, entry) {
    onDataChange({ ...data, podNotes: { ...podNotes, [groupKey]: entry } });
  }

  function reassignPod(groupKey, podKey) {
    const updated = { ...podAssignments };
    if (podKey === 'auto') delete updated[groupKey];
    else updated[groupKey] = podKey;
    onDataChange({ ...data, podAssignments: updated });
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#032D60' }}>Pod Tracker</h2>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
          Negative feedback for {initiative.name} grouped by the pod that owns it. Set a status and note on any item to track what's being done about it.
        </p>
      </div>

      {negative.length === 0 ? (
        <div style={styles.empty}>No negative feedback to route yet.</div>
      ) : (
        <>
          <PodDashboard bucketStats={bucketStats} activeBucket={activeBucket} onSelect={setActiveBucket} />
          {(() => {
            const bucket = buckets.find(b => (b.pod ? b.pod.key : TRIAGE_KEY) === activeBucket);
            return (
              <PodBucket
                bucket={bucket}
                podNotes={podNotes}
                podAssignments={podAssignments}
                onSaveNote={saveNote}
                onReassign={reassignPod}
              />
            );
          })()}
        </>
      )}
    </div>
  );
}

function PodDashboard({ bucketStats, activeBucket, onSelect }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginBottom: 20 }}>
      {bucketStats.map(({ bucket, counts, total }) => {
        const key = bucket.pod ? bucket.pod.key : TRIAGE_KEY;
        const name = bucket.pod ? bucket.pod.name : 'Needs Triage';
        const isActive = activeBucket === key;
        return (
          <div key={key} onClick={() => onSelect(key)}
            style={{ ...styles.dashCard, cursor: 'pointer', border: isActive ? '2px solid #0176D3' : '2px solid transparent', boxShadow: isActive ? '0 2px 6px rgba(1,118,211,0.25)' : styles.dashCard.boxShadow }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: isActive ? '#0176D3' : '#1f2937', marginBottom: 2 }}>{name}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: '#032D60', marginBottom: 8 }}>{total}</div>
            {total > 0 && (
              <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
                {STATUSES.map(s => counts[s] > 0 && (
                  <div key={s} style={{ background: STATUS_COLORS[s], width: `${(counts[s] / total) * 100}%` }} />
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {STATUSES.map(s => (
                <div key={s} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280' }}>
                  <span><span style={{ color: STATUS_COLORS[s] }}>●</span> {s}</span>
                  <span style={{ fontWeight: 600, color: '#374151' }}>{counts[s]}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PodBucket({ bucket, podNotes, podAssignments, onSaveNote, onReassign }) {
  const { pod, groups } = bucket;
  const title = pod ? pod.name : '⚠️ Needs Triage';
  const subtitle = pod ? `${pod.focus} · Lead: ${pod.lead}${pod.members.length ? ', ' + pod.members.join(', ') : ''}` : 'No pod keyword matched — route these manually';

  return (
    <div>
      <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '2px solid #e5e7eb' }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: pod ? '#032D60' : '#92400e' }}>{title}</span>
        <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>{groups.length} item{groups.length !== 1 ? 's' : ''}</span>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{subtitle}</div>
      </div>
      {groups.length === 0 ? (
        <div style={{ ...styles.empty, padding: 16 }}>None found.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groups.map(g => (
            <GroupCard
              key={g.groupKey}
              group={g}
              bucketPod={pod}
              entry={normalizeEntry(podNotes[g.groupKey])}
              isManual={!!podAssignments[g.groupKey]}
              onSaveNote={onSaveNote}
              onReassign={onReassign}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupCard({ group, bucketPod, entry, isManual, onSaveNote, onReassign }) {
  const [draft, setDraft] = useState(entry);
  const dirty = draft.note !== entry.note || draft.status !== entry.status || draft.assignee !== entry.assignee;

  return (
    <div style={styles.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
        <p style={{ fontSize: 14, color: '#1f2937', lineHeight: 1.5, flex: 1 }}>{group.summary}</p>
        <select
          value={draft.status}
          onChange={e => setDraft({ ...draft, status: e.target.value })}
          style={{ ...styles.statusSelect, color: STATUS_COLORS[draft.status], borderColor: STATUS_COLORS[draft.status] }}>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        <span>📣 {group.sourceIds.length} report{group.sourceIds.length !== 1 ? 's' : ''}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ color: '#9ca3af' }}>👤</span>
          <select
            value={draft.assignee}
            onChange={e => setDraft({ ...draft, assignee: e.target.value })}
            style={styles.assigneeSelect}>
            <option value="">Unassigned</option>
            {bucketPod ? (
              podPeople(bucketPod).map(person => (
                <option key={person} value={person}>{person}{person === bucketPod.lead ? ' (Lead)' : ''}</option>
              ))
            ) : (
              PODS.map(p => (
                <optgroup key={p.key} label={p.name}>
                  {podPeople(p).map(person => (
                    <option key={person} value={person}>{person}{person === p.lead ? ' (Lead)' : ''}</option>
                  ))}
                </optgroup>
              ))
            )}
          </select>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {isManual && <span style={{ color: '#0176D3', fontWeight: 600 }}>✎ Manually assigned</span>}
          <select
            defaultValue=""
            onChange={e => { if (e.target.value) { onReassign(group.groupKey, e.target.value); e.target.value = ''; } }}
            style={styles.moveSelect}>
            <option value="" disabled>Move to pod…</option>
            <option value="auto">Auto-detect</option>
            {PODS.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
            <option value={TRIAGE_KEY}>Needs Triage</option>
          </select>
        </span>
      </div>
      <label style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
        Notes
      </label>
      <textarea
        value={draft.note}
        onChange={e => setDraft({ ...draft, note: e.target.value })}
        placeholder="What's being done about this? e.g. 'Assigned to Bhavik, fix targeted for next sprint.'"
        style={styles.textarea}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
        <button
          onClick={() => onSaveNote(group.groupKey, draft)}
          disabled={!dirty}
          style={{ ...styles.saveBtn, opacity: dirty ? 1 : 0.5, cursor: dirty ? 'pointer' : 'default' }}>
          {dirty ? 'Save' : 'Saved'}
        </button>
      </div>
    </div>
  );
}

const styles = {
  empty: { background: '#fff', borderRadius: 8, padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 14, border: '1px dashed #e5e7eb' },
  dashCard: { background: '#fff', borderRadius: 8, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
  card: { background: '#fff', borderRadius: 8, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
  textarea: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '7px 10px', fontSize: 13, minHeight: 56, resize: 'vertical', outline: 'none', fontFamily: 'inherit' },
  saveBtn: { fontSize: 12, fontWeight: 600, border: '1px solid #0176D3', color: '#0176D3', background: '#fff', borderRadius: 6, padding: '5px 14px' },
  statusSelect: { fontSize: 12, fontWeight: 600, borderRadius: 6, padding: '4px 8px', background: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' },
  moveSelect: { fontSize: 11, fontWeight: 600, color: '#0176D3', border: '1px solid #bfe0fa', borderRadius: 6, padding: '3px 6px', background: '#eaf4fd', cursor: 'pointer' },
  assigneeSelect: { fontSize: 11, fontWeight: 600, color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '3px 6px', background: '#fff', cursor: 'pointer', maxWidth: 160 }
};
