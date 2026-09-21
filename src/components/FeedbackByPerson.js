import React, { useMemo, useState } from 'react';
import { formatDate } from '../data';
import { matchJiraIssue } from './FeedbackAnalysisPanel';
import { matchRoadmap } from '../roadmapData';
import ActionItems from './ActionItems';

// Kept in sync with the identical bucket logic in FeedbackAnalysisPanel.js — this component
// needs its own badge markup (inline in a flex row, not the block layout used there), so it
// can't just import DeliveryBadges from there, but the status logic must stay identical.
function jiraStatusBucket(jiraMatch) {
  if (jiraMatch && jiraMatch.statusCategory) {
    if (jiraMatch.statusCategory === 'done') return 'done';
    if (jiraMatch.statusCategory === 'indeterminate') return 'in-progress';
    return jiraMatch.sprintState === 'active' ? 'in-progress' : 'planned';
  }
  const s = ((jiraMatch && jiraMatch.status) || '').toLowerCase();
  if (/(done|closed|resolved|deployed|released)/.test(s)) return 'done';
  if (/(progress|review|dev|testing|qa|staged)/.test(s)) return 'in-progress';
  return 'planned';
}

const JIRA_BUCKET_STYLE = {
  done: { color: '#059669', background: '#ecfdf5', border: '#a7f3d0', label: '✓ Done' },
  'in-progress': { color: '#0369a1', background: '#eff6ff', border: '#bfdbfe', label: '🔧 In Progress' },
  planned: { color: '#6b7280', background: '#f3f4f6', border: '#e5e7eb', label: '📋 Planned' }
};

function DeliveryBadges({ jiraMatch, roadmapMatch }) {
  if (!jiraMatch && !roadmapMatch) return null;
  return (
    <>
      {jiraMatch && (() => {
        const bucket = JIRA_BUCKET_STYLE[jiraStatusBucket(jiraMatch)];
        const label = jiraStatusBucket(jiraMatch) === 'planned' && jiraMatch.sprint
          ? `📅 Planned · ${jiraMatch.sprint}`
          : bucket.label;
        const title = [
          `${jiraMatch.key}: ${jiraMatch.summary} (${jiraMatch.status})`,
          jiraMatch.parentSummary ? `Epic: ${jiraMatch.parentSummary}` : null,
          jiraMatch.sprint ? `Sprint: ${jiraMatch.sprint}` : null
        ].filter(Boolean).join(' · ');
        return (
          <span
            style={{ fontSize: 11, fontWeight: 600, color: bucket.color, background: bucket.background, border: `1px solid ${bucket.border}`, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}
            title={title}>
            {label} · {jiraMatch.key}
          </span>
        );
      })()}
      {roadmapMatch && (
        <span style={styles.roadmapTag} title={roadmapMatch.level === 'item' ? `Scheduled: ${roadmapMatch.name}` : `Touches the ${roadmapMatch.name} roadmap area`}>
          📅 {roadmapMatch.level === 'item' ? `Planned ${roadmapMatch.target}` : `Roadmap: ${roadmapMatch.name}`}
        </span>
      )}
    </>
  );
}

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

// Runs the exact same dedup pass Feedback Analysis uses — across ALL feedback, not just
// one person's — so the two tabs never disagree about what counts as "one unique point".
// Feedback Analysis merges two different people describing the same issue into one group;
// if By Person deduped per-person only, it would double-count that group (once per person)
// and its totals would drift from Feedback Analysis's number. Running dedup globally first,
// then attributing each resulting group to whichever person(s) contributed to it, keeps the
// final unique-point count identical between the two tabs — a shared point just shows up
// under every person who reported it, tagged with who else reported it too.
function groupByPerson(feedback, globalGroups, closedLoop, jiraIssues) {
  const feedbackById = new Map(feedback.map(f => [f.id, f]));

  const enrichedGroups = globalGroups.map(g => {
    const members = g.sourceIds.map(id => feedbackById.get(id)).filter(Boolean)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const reporters = Array.from(new Set(members.map(f => (f.providerName || '').trim() || 'Unknown')));
    const closedCount = members.filter(f => closedLoop[f.id]?.closed).length;
    const openActionCount = members.reduce((sum, f) => sum + (f.actionItems || []).filter(a => !a.done).length, 0);
    return {
      groupKey: g.groupKey,
      summary: g.summary,
      members,
      reporters,
      reportCount: members.length,
      closedCount,
      openCount: members.length - closedCount,
      openActionCount,
      latestDate: members[0]?.date || '',
      jiraMatch: matchJiraIssue(g.summary, jiraIssues),
      roadmapMatch: matchRoadmap(g.summary)
    };
  });

  const map = new Map();
  feedback.forEach(f => {
    const name = (f.providerName || '').trim() || 'Unknown';
    if (!map.has(name)) map.set(name, { name, role: f.providerRole || '', regions: new Set(), rawEntries: [] });
    const person = map.get(name);
    if (f.providerRole) person.role = f.providerRole;
    if (f.region) person.regions.add(f.region);
    person.rawEntries.push(f);
  });

  const people = Array.from(map.values()).map(person => {
    const points = enrichedGroups
      .filter(g => g.reporters.includes(person.name))
      .map(g => ({ ...g, sharedWith: g.reporters.filter(r => r !== person.name) }))
      .sort((a, b) => (b.latestDate || '').localeCompare(a.latestDate || ''));

    const rawEntries = person.rawEntries.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const duplicateCount = rawEntries.length - points.length;
    // Open/Closed are counted per unique point (post-dedup), not per raw submission — a point
    // only counts as closed once every submission of it (from anyone) has been closed out.
    const closedCount = points.filter(p => p.openCount === 0).length;
    const openActionCount = points.reduce((sum, p) => sum + p.openActionCount, 0);

    return {
      name: person.name,
      role: person.role,
      regions: Array.from(person.regions),
      points,
      uniqueCount: points.length,
      rawTotal: rawEntries.length,
      duplicateCount,
      closedCount,
      openCount: points.length - closedCount,
      openActionCount
    };
  }).sort((a, b) => b.rawTotal - a.rawTotal);

  return { people, finalUniqueCount: globalGroups.length };
}

export default function FeedbackByPerson({ data, onDataChange, onEditClosedLoop, filterInitiativeId, globalGroups = [] }) {
  const [search, setSearch] = useState('');
  const [expandedPerson, setExpandedPerson] = useState(null);
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [expandedEntry, setExpandedEntry] = useState(null);

  const feedback = useMemo(
    () => filterInitiativeId ? data.feedback.filter(f => f.initiativeId === filterInitiativeId) : data.feedback,
    [data.feedback, filterInitiativeId]
  );
  const jiraIssues = data.jiraIssues || [];
  const { people, finalUniqueCount } = useMemo(
    () => groupByPerson(feedback, globalGroups, data.closedLoop, jiraIssues),
    [feedback, globalGroups, data.closedLoop, jiraIssues]
  );

  const filtered = search
    ? people.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    : people;

  function initiativeName(id) {
    const i = data.initiatives.find(x => x.id === id);
    return i ? i.name : '—';
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#032D60' }}>
          Feedback by Person
          <span style={{ fontSize: 14, fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>({people.length} people · {feedback.length} inputs)</span>
        </h2>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
          Who's given feedback, how much, and whether it's been acted on yet — deduplicated using the exact same pass as Feedback Analysis, so a point one person raised and another person also raised counts as <strong>1</strong> in both tabs, not 2.
        </p>
        <div style={styles.reconcileBar}>
          <strong>{finalUniqueCount}</strong> unique point{finalUniqueCount !== 1 ? 's' : ''} total across everyone — matches the count shown in Feedback Analysis.
        </div>
      </div>

      <input
        style={styles.search}
        placeholder="Search by name..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {filtered.length === 0 ? (
        <div style={styles.empty}>No matching people.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(person => {
            const isOpen = expandedPerson === person.name;
            const needsAction = person.openCount > 0 || person.openActionCount > 0;
            return (
              <div key={person.name} style={styles.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                  onClick={() => setExpandedPerson(isOpen ? null : person.name)}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>{person.name}</span>
                    {person.role && <span style={styles.tag}>{person.role}</span>}
                    {person.regions.map(r => <span key={r} style={styles.tag}>{r}</span>)}
                    {person.duplicateCount > 0 && (
                      <span style={styles.dedupTag} title="Repeated reports of the same issue from this person were merged">
                        🔁 {person.duplicateCount} duplicate{person.duplicateCount !== 1 ? 's' : ''} merged
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                    <MiniStat label="Unique" value={person.uniqueCount} />
                    <MiniStat label="Raw" value={person.rawTotal} />
                    <MiniStat label="Closed" value={person.closedCount} color="#059669" />
                    <MiniStat label="Open" value={person.openCount} color={person.openCount > 0 ? '#d97706' : '#9ca3af'} />
                    {person.openActionCount > 0 && (
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#d97706', background: '#fef3c7', padding: '3px 8px', borderRadius: 10, whiteSpace: 'nowrap' }}>
                        {person.openActionCount} action{person.openActionCount !== 1 ? 's' : ''} open
                      </span>
                    )}
                    {!needsAction && <span style={{ fontSize: 12, fontWeight: 600, color: '#059669' }}>✓ All handled</span>}
                    <span style={{ color: '#9ca3af', fontSize: 18 }}>{isOpen ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {person.points.map(point => {
                      const groupOpen = expandedGroup === point.groupKey;
                      const closed = point.openCount === 0;
                      return (
                        <div key={point.groupKey} style={{ ...styles.pointRow, borderLeft: `3px solid ${closed ? '#059669' : '#d97706'}` }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}
                            onClick={() => setExpandedGroup(groupOpen ? null : point.groupKey)}>
                            <div style={{ flex: 1 }}>
                              <p style={{ fontSize: 14, color: '#1f2937', lineHeight: 1.5, marginBottom: 6 }}>{point.summary}</p>
                              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: '#6b7280' }}>
                                {point.reportCount > 1 && (
                                  <span style={styles.dedupTag}>🔁 Reported {point.reportCount}x</span>
                                )}
                                {point.sharedWith.length > 0 && (
                                  <span style={styles.sharedTag} title="This is the same underlying point Feedback Analysis merged across these people">
                                    🔗 Also reported by {point.sharedWith.join(', ')}
                                  </span>
                                )}
                                <span style={{ fontWeight: 600, color: closed ? '#059669' : '#d97706' }}>
                                  {closed ? '✓ Loop Closed' : `⚡ ${point.openCount} open`}
                                </span>
                                {point.openActionCount > 0 && (
                                  <span style={{ background: '#fef3c7', color: '#d97706', padding: '2px 7px', borderRadius: 10, fontWeight: 600 }}>
                                    {point.openActionCount} action{point.openActionCount > 1 ? 's' : ''} open
                                  </span>
                                )}
                                <DeliveryBadges jiraMatch={point.jiraMatch} roadmapMatch={point.roadmapMatch} />
                              </div>
                            </div>
                            <span style={{ color: '#9ca3af', fontSize: 14 }}>{groupOpen ? '▲' : '▼'}</span>
                          </div>

                          {groupOpen && (
                            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #f3f4f6', display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {point.members.map(f => {
                                const cl = data.closedLoop[f.id];
                                const entryClosed = cl ? cl.closed : false;
                                const entryOpen = expandedEntry === f.id;
                                const text = combinedNotes(f);
                                const openActions = (f.actionItems || []).filter(a => !a.done).length;
                                return (
                                  <div key={f.id} style={{ ...styles.entryRow, borderLeft: `3px solid ${entryClosed ? '#059669' : '#d97706'}` }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                                      onClick={() => setExpandedEntry(entryOpen ? null : f.id)}>
                                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: 13, color: '#6b7280' }}>{formatDate(f.date)}</span>
                                        {f.initiativeId && <span style={{ ...styles.tag, background: '#e0f0ff', color: '#0176D3' }}>{initiativeName(f.initiativeId)}</span>}
                                        {f.format && <span style={styles.tag}>{f.format}</span>}
                                        {openActions > 0 && (
                                          <span style={{ fontSize: 11, background: '#fef3c7', color: '#d97706', padding: '2px 7px', borderRadius: 10, fontWeight: 600 }}>
                                            {openActions} action{openActions > 1 ? 's' : ''}
                                          </span>
                                        )}
                                      </div>
                                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                        <span style={{ fontSize: 12, fontWeight: 600, color: entryClosed ? '#059669' : '#d97706' }}>
                                          {entryClosed ? '✓ Loop Closed' : '⚡ Open'}
                                        </span>
                                        <button onClick={e => { e.stopPropagation(); onEditClosedLoop(f.id); }} style={styles.smallBtn}>
                                          {entryClosed ? 'View Loop' : 'Close Loop'}
                                        </button>
                                        <span style={{ color: '#9ca3af', fontSize: 14 }}>{entryOpen ? '▲' : '▼'}</span>
                                      </div>
                                    </div>

                                    {entryOpen && (
                                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #f3f4f6' }}>
                                        {text ? (
                                          <p style={{ fontSize: 14, color: '#1f2937', whiteSpace: 'pre-wrap', lineHeight: 1.6, marginBottom: 12 }}>{text}</p>
                                        ) : (
                                          <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12 }}>No notes captured.</p>
                                        )}
                                        {cl && cl.howIncorporated && (
                                          <div style={styles.actionBox}>
                                            <div style={{ fontSize: 11, fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                                              How it was acted on
                                            </div>
                                            <div style={{ fontSize: 13, color: '#0c4a6e', whiteSpace: 'pre-wrap' }}>{cl.howIncorporated}</div>
                                            {cl.communicatedBack && (
                                              <div style={{ fontSize: 12, color: '#0369a1', marginTop: 4 }}>
                                                Communicated back to provider: <strong>{cl.communicatedBack}</strong>
                                                {cl.communicationMethod ? ` (${cl.communicationMethod})` : ''}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                        <ActionItems feedback={f} data={data} onDataChange={onDataChange} />
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 46 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: color || '#374151' }}>{value}</div>
      <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
    </div>
  );
}

const styles = {
  search: { border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 12px', fontSize: 14, outline: 'none', width: 280, marginBottom: 16 },
  card: { background: '#fff', borderRadius: 8, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
  pointRow: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 12px' },
  entryRow: { background: '#f9fafb', borderRadius: 6, padding: '10px 12px' },
  tag: { fontSize: 12, background: '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: 10, fontWeight: 500 },
  dedupTag: { fontSize: 11, fontWeight: 600, color: '#0176D3', background: '#eaf4fd', border: '1px solid #bfe0fa', borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' },
  sharedTag: { fontSize: 11, fontWeight: 600, color: '#7c3aed', background: '#f3e8ff', border: '1px solid #ddd6fe', borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' },
  roadmapTag: { fontSize: 11, fontWeight: 600, color: '#7c3aed', background: '#f3e8ff', border: '1px solid #ddd6fe', borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' },
  reconcileBar: { fontSize: 12, color: '#374151', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 12px', marginTop: 10 },
  smallBtn: { fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#fff', whiteSpace: 'nowrap' },
  actionBox: { background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '8px 12px', marginBottom: 12 },
  empty: { background: '#fff', borderRadius: 8, padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 15 }
};
