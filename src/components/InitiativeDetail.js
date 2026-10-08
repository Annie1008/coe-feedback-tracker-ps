import React, { useState, useMemo, useRef } from 'react';
import FeedbackForm from './FeedbackForm';
import FeedbackTable from './FeedbackTable';
import ActionItems from './ActionItems';
import AIQueryBox from './AIQueryBox';
import FeedbackAnalysisPanel, { useDedupedFeedback } from './FeedbackAnalysisPanel';
import FeedbackByPerson from './FeedbackByPerson';
import TimelineView from './TimelineView';
import DumpedFeedbackPanel from './DumpedFeedbackPanel';
import CreatedJiraStoriesPanel from './CreatedJiraStoriesPanel';
// import PodTrackerPanel from './PodTrackerPanel'; // Pod Tracker tab disabled — replaced by Timeline below
import { REGIONS, OU_ENABLEMENT_FORMATS, formatDate } from '../data';

const TABS = ['Overview', 'Field Inputs', 'Feedback Analysis', 'By Person', 'Timeline', 'Dumped', 'Jira Stories'];

const API_BASE = process.env.REACT_APP_API_ORIGIN || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001');
const tabId = label => label.toLowerCase().replace(/\s+/g, '-');

// Every Accept/Dismiss on an AI suggestion is a labeled data point for the Dashboard's
// "AI Suggestion Accuracy" card — counted per suggestion-decision (not per ticket inside a
// multi-ticket match), so month and Jira accuracy stay on the same unit.
function bumpSuggestionOutcome(data, type, kind) {
  const outcomes = { ...(data.suggestionOutcomes || {}) };
  const bucket = { ...(outcomes[type] || { accepted: 0, dismissed: 0 }) };
  bucket[kind] = (bucket[kind] || 0) + 1;
  outcomes[type] = bucket;
  return outcomes;
}

export default function InitiativeDetail({ initiativeId, data, onDataChange, onBack, onEditClosedLoop, fieldMutations }) {
  const [tab, setTab] = useState('Overview');
  const [showForm, setShowForm] = useState(false);
  const [editRollout, setEditRollout] = useState(false);
  const [rolloutVal, setRolloutVal] = useState('');
  const [expandedFeedbackId, setExpandedFeedbackId] = useState(null);
  const [editingOU, setEditingOU] = useState(null);
  const [editingEntry, setEditingEntry] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [refreshingJira, setRefreshingJira] = useState(false);
  const [refreshJiraError, setRefreshJiraError] = useState(null);
  const tabRefs = useRef([]);

  const initiative = data.initiatives.find(i => i.id === initiativeId);
  if (!initiative) return null;

  const feedback = useMemo(() => data.feedback.filter(f => f.initiativeId === initiativeId), [data.feedback, initiativeId]);
  const openCount = feedback.filter(f => !data.closedLoop[f.id]?.closed).length;
  const feedbackById = useMemo(() => new Map(feedback.map(f => [f.id, f])), [feedback]);
  // Computed once here and threaded down to Feedback Analysis, By Person, and Timeline as props
  // — each used to call this hook independently, meaning three separate AI calls per initiative
  // that could return slightly different groupings (LLM clustering isn't guaranteed identical
  // run-to-run). One shared computation means all three tabs always agree on the same groups.
  const { groups: allGroups, status: dedupStatus } = useDedupedFeedback(feedback, initiativeId);
  // Dumped groups are ones the team has explicitly marked "not actually actionable" — hide them
  // from Feedback Analysis and Timeline everywhere downstream, same as if dedup never grouped
  // them in the first place. They still exist (recoverable in the Dumped tab), just not counted.
  const dumpedGroups = data.dumpedGroups || {};
  const visibleGroups = useMemo(
    () => allGroups.filter(g => !dumpedGroups[g.groupKey || g.sourceIds.slice().sort().join(',')]),
    [allGroups, dumpedGroups]
  );
  // Complaints AND plain requests/questions are both things to plan/schedule — only pure
  // praise (Positive) has nothing to place on a delivery timeline.
  const actionableGroups = useMemo(() => visibleGroups.filter(g => g.sentiment !== 'Positive'), [visibleGroups]);
  // ouEnablement: { [region]: { enabled: bool, date: string, format: string, notes: string } }
  const ouEnablement = initiative.ouEnablement || {};
  const enabledOUCount = REGIONS.filter(r => ouEnablement[r]?.enabled).length;

  async function saveOUEnablement(region, patch) {
    const next = { ...ouEnablement, [region]: { ...(ouEnablement[region] || {}), ...patch } };
    await fieldMutations.upsertInitiative({ ...initiative, ouEnablement: next });
  }

  async function saveRollout() {
    await fieldMutations.upsertInitiative({ ...initiative, rolloutDate: rolloutVal });
    setEditRollout(false);
  }

  // Manual timeline placements ("we discussed it, we're targeting Nov") for feedback that has
  // no automatic Jira/roadmap date yet — keyed by the same groupKey buildGroup already derives
  // (sorted source feedback ids), so it survives re-dedup as long as the same items still group
  // together. Stored in the shared app_data blob like everything else, not per-user.
  function handleTimelineOverride(groupKey, monthKey) {
    const previousMonth = (data.timelineOverrides || {})[groupKey] || null;
    const overrides = { ...(data.timelineOverrides || {}) };
    if (monthKey) overrides[groupKey] = monthKey;
    else delete overrides[groupKey];

    // Picking exactly the month the AI suggested (and that suggestion wasn't already dismissed)
    // reads as accepting it — this is also what the suggestion banner's own Accept button does.
    const pendingSuggestion = (data.timelineSuggestions || {})[groupKey];
    const suggestionOutcomes = (pendingSuggestion?.month && pendingSuggestion.month === monthKey && !pendingSuggestion.dismissed)
      ? bumpSuggestionOutcome(data, 'month', 'accepted')
      : data.suggestionOutcomes;

    // Record the move so it shows up in the Dashboard's recent-changes feed — capped to the
    // most recent 200 so this log can't grow forever, same reasoning as why dedup caches get
    // versioned rather than accumulated indefinitely.
    const group = allGroups.find(g => (g.groupKey || g.sourceIds.slice().sort().join(',')) === groupKey);
    const entry = {
      id: `${groupKey}-${Date.now()}`,
      initiativeId,
      initiativeName: initiative.name,
      summary: (group?.summary || '').slice(0, 140),
      from: previousMonth,
      to: monthKey || null,
      changedAt: new Date().toISOString()
    };
    const history = [entry, ...(data.timelineHistory || [])].slice(0, 200);

    onDataChange({ ...data, timelineOverrides: overrides, timelineHistory: history, suggestionOutcomes });
  }

  // AI's suggested placement for undated feedback, cached per group so it's only (re)computed
  // when the group's summary actually changes — merges the whole patch in one go since it
  // arrives as a single batch from one AI call, not one field at a time. A patch that newly sets
  // `dismissed: true` is the user's Dismiss click (the only call sites that ever set it), so it
  // also counts as a suggestion-accuracy data point, same as an accepted one above.
  function handleTimelineSuggest(patch) {
    let suggestionOutcomes = data.suggestionOutcomes;
    Object.entries(patch).forEach(([groupKey, entry]) => {
      const wasAlreadyDismissed = (data.timelineSuggestions || {})[groupKey]?.dismissed;
      if (entry?.dismissed && !wasAlreadyDismissed) {
        suggestionOutcomes = bumpSuggestionOutcome({ ...data, suggestionOutcomes }, 'month', 'dismissed');
      }
    });
    onDataChange({ ...data, timelineSuggestions: { ...(data.timelineSuggestions || {}), ...patch }, suggestionOutcomes });
  }

  // AI's suggested EXISTING-ticket match for feedback with no automatic Jira/roadmap signal,
  // cached per group the same way handleTimelineSuggest caches month suggestions above — only
  // re-asked once the group's summary actually changes. A patch that newly sets `dismissed: true`
  // is the user's Dismiss click, counted toward suggestion accuracy same as an accepted one below.
  function handleJiraMatchSuggest(patch) {
    let suggestionOutcomes = data.suggestionOutcomes;
    Object.entries(patch).forEach(([groupKey, entry]) => {
      const wasAlreadyDismissed = (data.jiraMatchSuggestions || {})[groupKey]?.dismissed;
      if (entry?.dismissed && !wasAlreadyDismissed) {
        suggestionOutcomes = bumpSuggestionOutcome({ ...data, suggestionOutcomes }, 'jira', 'dismissed');
      }
    });
    onDataChange({ ...data, jiraMatchSuggestions: { ...(data.jiraMatchSuggestions || {}), ...patch }, suggestionOutcomes });
  }

  // Accepting an AI-suggested match links the group to one or more EXISTING tickets the same
  // way handleCreateJiraStory links a newly-created one — classify() already prefers
  // manualJiraLinks over any automatic match, so this takes over immediately without a Jira API
  // call. A feedback group can genuinely cover more than one ticket, so this takes an array of
  // keys and writes them all in a single update (each under its own `groupKey::ticketKey` entry,
  // so a group isn't limited to one linked ticket).
  function handleAcceptJiraMatch(groupKey, group, ticketKeys) {
    const keys = Array.isArray(ticketKeys) ? ticketKeys : [ticketKeys];
    const additions = {};
    keys.forEach(ticketKey => {
      const issue = (data.jiraIssues || []).find(j => j.key === ticketKey);
      if (!issue) return;
      additions[`${groupKey}::${issue.key}`] = {
        groupKey,
        initiativeId,
        initiativeName: initiative.name,
        key: issue.key,
        url: issue.url || '',
        summary: issue.summary,
        sourceIds: group?.sourceIds || [],
        linked: true,
        createdAt: new Date().toISOString()
      };
    });
    if (Object.keys(additions).length === 0) return;
    onDataChange({
      ...data,
      manualJiraLinks: { ...(data.manualJiraLinks || {}), ...additions },
      suggestionOutcomes: bumpSuggestionOutcome(data, 'jira', 'accepted')
    });
  }

  // Free-text discussion notes on the three undated Timeline buckets — same groupKey-based
  // storage as timelineOverrides above, so a note survives re-dedup as long as the same
  // underlying feedback keeps clustering into this group.
  function handleTimelineNote(groupKey, text) {
    const notes = { ...(data.timelineNotes || {}) };
    if (text) notes[groupKey] = text;
    else delete notes[groupKey];
    onDataChange({ ...data, timelineNotes: notes });
  }

  // "Not Needed" — the team looked at this group and decided it isn't actually actionable.
  // Recoverable: stored as its own record (not deleted) so it can be restored from the Dumped tab.
  function handleDumpGroup(groupKey, group, fromLabel) {
    const entry = {
      groupKey,
      initiativeId,
      initiativeName: initiative.name,
      summary: group?.summary || '',
      sourceIds: group?.sourceIds || [],
      from: fromLabel || null,
      dumpedAt: new Date().toISOString()
    };
    onDataChange({ ...data, dumpedGroups: { ...(data.dumpedGroups || {}), [groupKey]: entry } });
  }

  function handleRestoreGroup(groupKey) {
    const remaining = { ...(data.dumpedGroups || {}) };
    delete remaining[groupKey];
    onDataChange({ ...data, dumpedGroups: remaining });
  }

  // Manual "Mark Fixed" — a human confirming a group is actually resolved, independent of any
  // Jira/roadmap signal. Drives careStatus() in TimelineView, so Feedback Care Coverage's counts
  // and percentages recompute immediately off this the same way they do off overrides/Jira data.
  function handleMarkFixed(groupKey, group, note) {
    const entry = {
      groupKey,
      initiativeId,
      initiativeName: initiative.name,
      summary: group?.summary || '',
      sourceIds: group?.sourceIds || [],
      note: note || '',
      fixedAt: new Date().toISOString()
    };
    onDataChange({ ...data, fixedGroups: { ...(data.fixedGroups || {}), [groupKey]: entry } });
  }

  function handleUnmarkFixed(groupKey) {
    const remaining = { ...(data.fixedGroups || {}) };
    delete remaining[groupKey];
    onDataChange({ ...data, fixedGroups: remaining });
  }

  // Spins up a real Jira Story directly from a feedback group that has no matching ticket at
  // all, so it doesn't just sit as "needs manual triage" forever. Links it to this groupKey
  // immediately (classify() prefers this over the text-match), and a later Jira sync will pick
  // up its real sprint/status once it's actually scheduled.
  async function handleCreateJiraStory(groupKey, group, assigneeEmail) {
    const detailText = group.sourceIds
      .map(id => data.feedback.find(f => f.id === id))
      .filter(Boolean)
      .map(f => `${f.providerName || 'Anonymous'}${f.providerRole ? ` (${f.providerRole})` : ''}: ${f.frictionPoints || f.notes || ''}`)
      .join('\n\n');

    const res = await fetch(`${API_BASE}/api/jira-create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: group.summary, description: detailText, assigneeEmail })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Jira create failed (HTTP ${res.status})`);

    onDataChange({
      ...data,
      manualJiraLinks: {
        ...(data.manualJiraLinks || {}),
        [`${groupKey}::${json.key}`]: {
          groupKey,
          initiativeId,
          initiativeName: initiative.name,
          key: json.key,
          url: json.url,
          summary: json.issue.summary,
          sourceIds: group.sourceIds || [],
          createdAt: json.issue.updated
        }
      }
    });
    return json;
  }

  // Timeline's own refresh — re-pulls live sprint/status/release data from Jira and applies it
  // immediately, no preview step, unlike the full Jira Sync panel elsewhere. Just for the
  // Timeline tab: it doesn't touch feedback, dedup, or anything else on the page.
  async function handleTimelineRefresh() {
    setRefreshingJira(true);
    setRefreshJiraError(null);
    try {
      const res = await fetch(`${API_BASE}/api/jira-sync`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Sync failed (HTTP ${res.status})`);
      onDataChange({ ...data, jiraIssues: json.issues, jiraSyncedAt: json.syncedAt });
    } catch (e) {
      setRefreshJiraError(e.message);
    } finally {
      setRefreshingJira(false);
    }
  }

  async function handleDelete(id) {
    await fieldMutations.remove(data.feedback.find(f => f.id === id));
    setConfirmDeleteId(null);
    if (expandedFeedbackId === id) setExpandedFeedbackId(null);
  }

  function handleTabKeyDown(event, index) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = TABS.length - 1;
    setTab(TABS[nextIndex]);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <div style={{ padding: '24px' }}>
      <button onClick={onBack} style={styles.backBtn}>← Back to Initiatives</button>

      <div style={{ ...styles.header, borderTop: `5px solid ${initiative.color}` }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: initiative.color }}>{initiative.name}</h1>
          <p style={{ color: '#6b7280', marginTop: 4, fontSize: 14 }}>{initiative.description}</p>
        </div>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          <Stat label="Total Inputs" value={feedback.length} />
          <Stat label="Open Loops" value={openCount} warn={openCount > 0} />
          <Stat label="OUs Enabled" value={enabledOUCount} />
          <div>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>Rollout Date</div>
            {editRollout ? (
              <div style={{ display: 'flex', gap: 4 }}>
                <input type="date" value={rolloutVal} onChange={e => setRolloutVal(e.target.value)} style={styles.smallInput} />
                <button onClick={saveRollout} style={styles.tinyBtn}>Save</button>
              </div>
            ) : (
              <span onClick={() => { setRolloutVal(initiative.rolloutDate || ''); setEditRollout(true); }}
                style={{ fontSize: 15, fontWeight: 700, cursor: 'pointer', color: '#1f2937' }}>
                {initiative.rolloutDate || 'Set date ✎'}
              </span>
            )}
          </div>
        </div>
      </div>

      <div style={styles.tabs}>
        <div role="tablist" aria-label="Initiative detail sections" style={{ display: 'flex' }}>
          {TABS.map((t, index) => (
            <button key={t} id={`initiative-tab-${tabId(t)}`} role="tab"
              aria-selected={tab === t} aria-controls="initiative-tabpanel"
              tabIndex={tab === t ? 0 : -1} ref={element => { tabRefs.current[index] = element; }}
              className="initiative-detail-tab" onKeyDown={event => handleTabKeyDown(event, index)} onClick={() => setTab(t)}
              style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }}>
              {t}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowForm(true)} style={styles.primaryBtn}>+ New Field Input</button>
      </div>

      {showForm && (
        <div style={styles.formWrap}>
          <FeedbackForm data={data} onDataChange={onDataChange} defaultInitiativeId={initiativeId} onClose={() => setShowForm(false)} fieldMutations={fieldMutations} />
        </div>
      )}

      <div id="initiative-tabpanel" role="tabpanel" tabIndex={0}
        aria-labelledby={`initiative-tab-${tabId(tab)}`}>
      {tab === 'Overview' && (
        <div>
          <AIQueryBox data={data} initiativeId={initiativeId} />
          <h3 style={{ margin: '0 0 10px', fontWeight: 700, color: '#032D60' }}>Field Enabled by OU</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
            {REGIONS.map(r => {
              const ou = ouEnablement[r] || {};
              const isEnabled = !!ou.enabled;
              const hasFeedback = feedback.some(f => f.region === r);
              return (
                <div key={r} style={{ ...styles.ouRow, borderLeft: `3px solid ${isEnabled ? initiative.color : '#e5e7eb'}`, background: isEnabled ? '#f0f7ff' : '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                      <input type="checkbox" checked={isEnabled}
                        disabled={fieldMutations.busy || fieldMutations.readOnly}
                        onChange={e => saveOUEnablement(r, { enabled: e.target.checked })}
                        style={{ width: 15, height: 15, accentColor: initiative.color }} />
                      <span style={{ color: isEnabled ? initiative.color : '#374151' }}>{r}</span>
                    </label>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {hasFeedback && <span title="Has feedback logged" style={{ fontSize: 11, color: '#6b7280' }}>💬</span>}
                      <button disabled={fieldMutations.busy || fieldMutations.readOnly} onClick={() => setEditingOU(r)} style={styles.tinyBtn2}>
                        {isEnabled ? 'Edit' : 'Details'}
                      </button>
                    </div>
                  </div>
                  {isEnabled && (ou.date || ou.format) && (
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, paddingLeft: 23 }}>
                      {ou.date && <span>📅 {ou.date}</span>}
                      {ou.date && ou.format && <span> · </span>}
                      {ou.format && <span>📋 {ou.format}</span>}
                      {ou.notes && <div style={{ marginTop: 2, fontStyle: 'italic' }}>{ou.notes}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <h3 id="recent-feedback-heading" tabIndex="-1" style={{ margin: '20px 0 10px', fontWeight: 700, color: '#032D60' }}>Recent Feedback</h3>
          {feedback.length === 0
            ? <p style={{ color: '#9ca3af', fontSize: 14 }}>No feedback yet. Click "+ New Field Input" to add the first entry.</p>
            : feedback.slice(0, 5).map(f => {
              const isOpen = expandedFeedbackId === f.id;
              const closed = data.closedLoop[f.id]?.closed;
              return (
                <div key={f.id} style={{ ...styles.miniRow, borderLeft: `3px solid ${closed ? '#059669' : '#d97706'}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <button aria-expanded={isOpen} aria-controls={`recent-feedback-${f.id}`} onClick={() => setExpandedFeedbackId(isOpen ? null : f.id)} style={{ flex: 1, border: 0, background: 'transparent', textAlign: 'left', padding: 0 }}>
                    <span>
                      <strong>{f.providerName}</strong>
                      {f.providerRole && <span style={{ color: '#6b7280', fontSize: 13 }}> · {f.providerRole}</span>}
                      <span style={{ color: '#6b7280', fontSize: 13 }}> · {f.region} · {formatDate(f.date)}</span>
                    </span>
                    </button>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: closed ? '#059669' : '#d97706' }}>
                        {closed ? '✓ Closed' : '⚡ Open'}
                      </span>
                       <button disabled={fieldMutations.busy || fieldMutations.readOnly} onClick={e => { e.stopPropagation(); onEditClosedLoop(f.id); }}
                        style={styles.tinyBtn2}>
                        {closed ? 'View Loop' : 'Close Loop'}
                      </button>
                       <button disabled={fieldMutations.busy || fieldMutations.readOnly} onClick={e => { e.stopPropagation(); setEditingEntry(f); setExpandedFeedbackId(null); }}
                        style={styles.tinyBtn2}>
                        ✎ Edit
                      </button>
                      <button aria-label={`Delete recent Field Input from ${f.providerName}`} disabled={fieldMutations.busy || fieldMutations.readOnly} onClick={e => { e.stopPropagation(); setConfirmDeleteId(f.id); }}
                        style={{ ...styles.tinyBtn2, borderColor: '#fecaca', color: '#dc2626' }}>
                        🗑
                      </button>
                      <span style={{ color: '#9ca3af' }}>{isOpen ? '▲' : '▼'}</span>
                    </div>
                  </div>
                  {!isOpen && f.frictionPoints && (
                    <p style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
                      {f.frictionPoints.slice(0, 120)}{f.frictionPoints.length > 120 ? '…' : ''}
                    </p>
                  )}
                  {isOpen && (
                    <div id={`recent-feedback-${f.id}`} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #e5e7eb' }}>
                      {(() => {
                        const parts = [];
                        if (f.frictionPoints) parts.push(`Friction Points:\n${f.frictionPoints}`);
                        if (f.toolsMentioned) parts.push(`Tools Mentioned:\n${f.toolsMentioned}`);
                        if (f.workarounds) parts.push(`Workarounds:\n${f.workarounds}`);
                        if (f.dealImpact) parts.push(`Deal Impact:\n${f.dealImpact}`);
                        if (f.quotes) parts.push(`Direct Quotes:\n${f.quotes}`);
                        if (f.notes) parts.push(f.notes);
                        const text = parts.join('\n\n');
                        return text
                          ? <p style={{ fontSize: 13, color: '#1f2937', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{text}</p>
                          : <p style={{ fontSize: 13, color: '#9ca3af' }}>No notes captured.</p>;
                      })()}
                      <ActionItems feedback={f} data={data} onDataChange={onDataChange} fieldMutations={fieldMutations} />
                    </div>
                  )}
                </div>
              );
            })
          }
          {feedback.length > 5 && (
            <button onClick={() => setTab('Field Inputs')} style={{ ...styles.ghostBtn, marginTop: 8 }}>
              View all {feedback.length} inputs →
            </button>
          )}
        </div>
      )}

      {editingOU && (
        <OUModal
          region={editingOU}
          current={ouEnablement[editingOU] || {}}
          color={initiative.color}
          onSave={patch => { saveOUEnablement(editingOU, patch); setEditingOU(null); }}
          onClose={() => setEditingOU(null)}
        />
      )}

      {tab === 'Field Inputs' && (
        <FeedbackTable data={data} onDataChange={onDataChange} onEditClosedLoop={onEditClosedLoop} filterInitiativeId={initiativeId} allGroups={allGroups} fieldMutations={fieldMutations} />
      )}

      {tab === 'Feedback Analysis' && (
        <FeedbackAnalysisPanel feedback={feedback} initiative={initiative} data={data} onDataChange={onDataChange} groups={visibleGroups} status={dedupStatus} />
      )}

      {tab === 'By Person' && (
        <FeedbackByPerson data={data} onDataChange={onDataChange} onEditClosedLoop={onEditClosedLoop} filterInitiativeId={initiativeId} globalGroups={allGroups} fieldMutations={fieldMutations} />
      )}

      {/* Pod Tracker tab disabled — kept here commented out for easy restore, replaced by Timeline.
      {tab === 'Pod Tracker' && (
        <PodTrackerPanel feedback={feedback} data={data} onDataChange={onDataChange} initiative={initiative} />
      )}
      */}

      {tab === 'Timeline' && (
        <TimelineView
          groups={actionableGroups}
          feedbackById={feedbackById}
          jiraIssues={data.jiraIssues || []}
          overrides={data.timelineOverrides || {}}
          onOverride={handleTimelineOverride}
          suggestions={data.timelineSuggestions || {}}
          onSuggest={handleTimelineSuggest}
          jiraSyncedAt={data.jiraSyncedAt}
          onRefresh={handleTimelineRefresh}
          refreshing={refreshingJira}
          refreshError={refreshJiraError}
          notes={data.timelineNotes || {}}
          onNote={handleTimelineNote}
          onDump={handleDumpGroup}
          fixedGroups={data.fixedGroups || {}}
          onMarkFixed={handleMarkFixed}
          onUnmarkFixed={handleUnmarkFixed}
          manualJiraLinks={data.manualJiraLinks || {}}
          onCreateJira={handleCreateJiraStory}
          jiraMatchSuggestions={data.jiraMatchSuggestions || {}}
          onJiraMatchSuggest={handleJiraMatchSuggest}
          onAcceptJiraMatch={handleAcceptJiraMatch}
        />
      )}

      {tab === 'Dumped' && (
        <DumpedFeedbackPanel
          dumped={Object.fromEntries(Object.entries(data.dumpedGroups || {}).filter(([, e]) => e.initiativeId === initiativeId))}
          onRestore={handleRestoreGroup}
        />
      )}

      {tab === 'Jira Stories' && (
        <CreatedJiraStoriesPanel
          links={Object.fromEntries(Object.entries(data.manualJiraLinks || {}).filter(([, e]) => e.initiativeId === initiativeId))}
        />
      )}
      </div>


      {editingEntry && (
        <div style={mStyles.overlay}>
          <div style={{ background: '#fff', borderRadius: 12, width: 820, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}>
            <FeedbackForm
              data={data}
              onDataChange={onDataChange}
              editEntry={editingEntry}
              onClose={() => setEditingEntry(null)}
              fieldMutations={fieldMutations}
            />
          </div>
        </div>
      )}

      {confirmDeleteId && (
        <div style={mStyles.overlay}>
          <div style={{ ...mStyles.box, maxWidth: 400 }}>
            <h3 style={{ color: '#032D60', marginBottom: 8 }}>Delete this feedback?</h3>
            <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 20 }}>
              This cannot be undone. Any closed loop data for this entry will also be removed.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDeleteId(null)} style={mStyles.ghost}>Cancel</button>
              <button onClick={() => handleDelete(confirmDeleteId)}
                style={{ background: '#dc2626', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OUModal({ region, current, color, onSave, onClose }) {
  const [form, setForm] = useState({
    enabled: current.enabled || false,
    date: current.date || '',
    format: current.format || '',
    notes: current.notes || ''
  });
  function set(f, v) { setForm(s => ({ ...s, [f]: v })); }
  return (
    <div style={mStyles.overlay}>
      <div style={mStyles.box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ color: '#032D60', fontWeight: 700 }}>OU Enablement — {region}</h3>
          <button onClick={onClose} style={mStyles.ghost}>✕</button>
        </div>
        <label style={mStyles.label}>
          <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)}
            style={{ width: 15, height: 15, marginRight: 8, accentColor: color }} />
          Mark as field enabled
        </label>
        <label style={{ ...mStyles.label, display: 'block', marginTop: 12 }}>Date Enabled</label>
        <input type="date" style={mStyles.input} value={form.date} onChange={e => set('date', e.target.value)} />
        <label style={{ ...mStyles.label, display: 'block' }}>Enablement Format</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {OU_ENABLEMENT_FORMATS.map(f => (
            <button key={f} onClick={() => set('format', f)}
              style={{ border: '1px solid', borderRadius: 20, padding: '4px 12px', fontSize: 12, cursor: 'pointer',
                background: form.format === f ? color : '#fff',
                color: form.format === f ? '#fff' : '#374151',
                borderColor: form.format === f ? color : '#d1d5db' }}>
              {f}
            </button>
          ))}
        </div>
        <label style={{ ...mStyles.label, display: 'block' }}>Notes</label>
        <textarea style={mStyles.textarea} value={form.notes} onChange={e => set('notes', e.target.value)}
          placeholder="Any additional context about this OU's enablement..." />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onClose} style={mStyles.ghost}>Cancel</button>
          <button onClick={() => onSave(form)} style={{ ...mStyles.primary, background: color }}>Save</button>
        </div>
      </div>
    </div>
  );
}

const mStyles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 },
  box: { background: '#fff', borderRadius: 12, padding: 24, width: 460, maxWidth: '95vw' },
  label: { fontSize: 13, fontWeight: 600, color: '#374151', display: 'flex', alignItems: 'center', cursor: 'pointer' },
  input: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '7px 10px', fontSize: 14, marginBottom: 12, outline: 'none' },
  textarea: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '7px 10px', fontSize: 14, height: 72, resize: 'vertical', outline: 'none', marginBottom: 12 },
  primary: { color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  ghost: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 14 }
};

function MiniField({ label, value }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}: </span>
      <span style={{ fontSize: 13, color: '#1f2937' }}>{value}</span>
    </div>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: warn ? '#d97706' : '#032D60' }}>{value}</div>
    </div>
  );
}

const styles = {
  backBtn: { background: 'none', border: 'none', color: '#0176D3', fontWeight: 600, cursor: 'pointer', fontSize: 14, marginBottom: 16, padding: 0 },
  header: { background: '#fff', borderRadius: 10, padding: 20, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  tabs: { display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', marginBottom: 16, alignItems: 'center' },
  tab: { padding: '10px 20px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#444950', borderBottom: '2px solid transparent', marginBottom: -2 },
  tabActive: { color: '#0b5cab', borderBottomColor: '#0b5cab' },
  primaryBtn: { background: '#0176D3', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  ghostBtn: { background: 'transparent', color: '#0176D3', border: '1px solid #0176D3', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600 },
  formWrap: { marginBottom: 20 },
  miniRow: { background: '#fff', borderRadius: 6, padding: '10px 14px', marginBottom: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.05)', fontSize: 14 },
  smallInput: { border: '1px solid #d1d5db', borderRadius: 4, padding: '4px 8px', fontSize: 13 },
  tinyBtn: { background: '#0176D3', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer' },
  tinyBtn2: { fontSize: 11, border: '1px solid #d1d5db', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', background: '#fff', whiteSpace: 'nowrap' },
  ouRow: { borderRadius: 6, padding: '10px 12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }
};
