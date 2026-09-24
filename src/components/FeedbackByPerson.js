import React, { useMemo, useState } from 'react';
import { formatDate, advisorsForRegion, advisorEmail, providerEmail } from '../data';
import { classify, careStatus, CARE_STYLE } from './TimelineView';
import ActionItems from './ActionItems';
import SendToAdvisorButton from './SendToAdvisorButton';
import ShareToChannelButton from './ShareToChannelButton';

const CARE_ORDER = ['done', 'in-progress', 'planned', 'not-addressed'];

function StatusBadge({ status }) {
  const s = CARE_STYLE[status];
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: s.color, background: s.background, border: `1px solid ${s.border}`, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
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
function groupByPerson(feedback, globalGroups, closedLoop, jiraIssues, timelineOverrides, fixedGroups, manualJiraLinks) {
  const feedbackById = new Map(feedback.map(f => [f.id, f]));

  const enrichedGroups = globalGroups.map(g => {
    const members = g.sourceIds.map(id => feedbackById.get(id)).filter(Boolean)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const reporters = Array.from(new Set(members.map(f => (f.providerName || '').trim() || 'Unknown')));
    const closedCount = members.filter(f => closedLoop[f.id]?.closed).length;
    const openActionCount = members.reduce((sum, f) => sum + (f.actionItems || []).filter(a => !a.done).length, 0);
    // Same classify()/careStatus() Timeline uses — so a group's "fixed / working on / not yet
    // addressed" read here can never disagree with what Timeline (and Field Inputs) say about it.
    const item = classify(g, feedbackById, jiraIssues, timelineOverrides, fixedGroups, manualJiraLinks);
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
      careStatusValue: careStatus(item),
      bucketLabel: item.bucketLabel
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

    // Per-person "what's happened with their feedback" dashboard — same 4 buckets Timeline
    // and Field Inputs use, counted once per unique point (not per raw submission).
    const statusCounts = { done: 0, 'in-progress': 0, planned: 0, 'not-addressed': 0 };
    points.forEach(p => { statusCounts[p.careStatusValue] = (statusCounts[p.careStatusValue] || 0) + 1; });

    // OU/CoE advisors who own this person's region(s) — same mapping Field Inputs uses, so
    // whoever's tracking a person's feedback here sees the same owner as anywhere else in the app.
    const advisors = Array.from(new Set(Array.from(person.regions).flatMap(r => advisorsForRegion(r))));

    return {
      name: person.name,
      role: person.role,
      regions: Array.from(person.regions),
      advisors,
      points,
      uniqueCount: points.length,
      rawTotal: rawEntries.length,
      duplicateCount,
      closedCount,
      openCount: points.length - closedCount,
      openActionCount,
      statusCounts
    };
  }).sort((a, b) => b.rawTotal - a.rawTotal);

  return { people, finalUniqueCount: globalGroups.length };
}

export default function FeedbackByPerson({ data, onDataChange, onEditClosedLoop, filterInitiativeId, globalGroups = [], fieldMutations }) {
  const [search, setSearch] = useState('');
  const [expandedPerson, setExpandedPerson] = useState(null);
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [expandedEntry, setExpandedEntry] = useState(null);

  // Message the OU/CoE advisor DM button sends for one entry — one place so the Slack message
  // and the on-screen status badge can never say something different.
  function advisorMessage(f, point) {
    const lines = [
      `Field input from ${f.providerName} (${f.region}, ${formatDate(f.date)})`,
      `Status: ${CARE_STYLE[point.careStatusValue].label}${point.bucketLabel ? ` — ${point.bucketLabel}` : ''}`
    ];
    return lines.join('\n');
  }

  // One digest covering every contributor's status — a single Slack post instead of one message
  // per person, for whoever wants to broadcast "here's where everything stands" to the channel.
  function allContributorsDigest(people, finalUniqueCount) {
    const totalClosed = people.reduce((s, p) => s + p.closedCount, 0);
    const totalOpen = people.reduce((s, p) => s + p.openCount, 0);
    const lines = [
      'Feedback status update — all contributors',
      `${finalUniqueCount} unique point${finalUniqueCount !== 1 ? 's' : ''} across ${people.length} people · ${totalClosed} closed · ${totalOpen} open`
    ];
    people.slice(0, 20).forEach(p => {
      lines.push(`• ${p.name}${p.regions.length ? ` (${p.regions.join(', ')})` : ''}: ${p.uniqueCount} pt${p.uniqueCount !== 1 ? 's' : ''} — ${p.closedCount} closed, ${p.openCount} open`);
    });
    if (people.length > 20) lines.push(`…and ${people.length - 20} more`);
    return lines.join('\n');
  }

  // One digest covering everything a single person has reported — for DMing that person
  // directly about the status of all their feedback, not just one entry at a time.
  function personDigest(person) {
    const lines = [
      `Feedback status update for ${person.name}${person.regions.length ? ` (${person.regions.join(', ')})` : ''}`,
      `${person.uniqueCount} unique point${person.uniqueCount !== 1 ? 's' : ''} · ${person.closedCount} closed · ${person.openCount} open`
    ];
    person.points.slice(0, 12).forEach(p => {
      lines.push(`• ${CARE_STYLE[p.careStatusValue].label}${p.bucketLabel ? ` (${p.bucketLabel})` : ''} — ${p.summary}`);
    });
    if (person.points.length > 12) lines.push(`…and ${person.points.length - 12} more`);
    return lines.join('\n');
  }

  const feedback = useMemo(
    () => filterInitiativeId ? data.feedback.filter(f => f.initiativeId === filterInitiativeId) : data.feedback,
    [data.feedback, filterInitiativeId]
  );
  const jiraIssues = data.jiraIssues || [];
  const timelineOverrides = data.timelineOverrides || {};
  const fixedGroups = data.fixedGroups || {};
  const manualJiraLinks = data.manualJiraLinks || {};
  const { people, finalUniqueCount } = useMemo(
    () => groupByPerson(feedback, globalGroups, data.closedLoop, jiraIssues, timelineOverrides, fixedGroups, manualJiraLinks),
    [feedback, globalGroups, data.closedLoop, jiraIssues, timelineOverrides, fixedGroups, manualJiraLinks]
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#032D60' }}>
            Feedback by Person
            <span style={{ fontSize: 14, fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>({people.length} people · {feedback.length} inputs)</span>
          </h2>
          {people.length > 0 && <ShareToChannelButton message={allContributorsDigest(people, finalUniqueCount)} />}
        </div>
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
                    {person.advisors.length > 0 && (
                      <span style={styles.dedupTag} title="OU/CoE advisor who owns this person's region(s)">
                        👤 {person.advisors.join(', ')}
                      </span>
                    )}
                    {person.duplicateCount > 0 && (
                      <span style={styles.dedupTag} title="Repeated reports of the same issue from this person were merged">
                        🔁 {person.duplicateCount} duplicate{person.duplicateCount !== 1 ? 's' : ''} merged
                      </span>
                    )}
                    <span onClick={e => e.stopPropagation()}>
                      <SendToAdvisorButton advisorName={person.name} email={providerEmail(person.name, data.providerEmails)} message={personDigest(person)} />
                    </span>
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

                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {CARE_ORDER.map(key => person.statusCounts[key] > 0 && (
                    <span key={key} style={{
                      fontSize: 11, fontWeight: 600, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap',
                      color: CARE_STYLE[key].color, background: CARE_STYLE[key].background, border: `1px solid ${CARE_STYLE[key].border}`
                    }}>
                      {CARE_STYLE[key].label}: {person.statusCounts[key]}
                    </span>
                  ))}
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
                                <StatusBadge status={point.careStatusValue} />
                                {point.careStatusValue !== 'not-addressed' && point.bucketLabel && (
                                  <span style={{ fontSize: 11, color: '#6b7280' }}>📅 {point.bucketLabel}</span>
                                )}
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
                                const entryAdvisors = advisorsForRegion(f.region);
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

                                    {entryAdvisors.length > 0 && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: 11, color: '#6b7280' }}>Owner: {entryAdvisors.join(', ')}</span>
                                        {entryAdvisors.map(name => (
                                          <SendToAdvisorButton key={name} advisorName={name} email={advisorEmail(name, data.advisorEmails)} message={advisorMessage(f, point)} />
                                        ))}
                                      </div>
                                    )}

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
                                        <ActionItems feedback={f} data={data} onDataChange={onDataChange} fieldMutations={fieldMutations} />
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
  reconcileBar: { fontSize: 12, color: '#374151', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 12px', marginTop: 10 },
  smallBtn: { fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#fff', whiteSpace: 'nowrap' },
  actionBox: { background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '8px 12px', marginBottom: 12 },
  empty: { background: '#fff', borderRadius: 8, padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 15 }
};
