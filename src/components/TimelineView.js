import React, { useMemo, useState, useEffect, useRef } from 'react';
import { matchAllJiraIssues, DeliveryBadges, feedbackDetailText, combinedText, jiraStatusBucket, suggestTimelineMonths, PEOPLE_EMAILS, splitFixVersions, jiraMatchCandidates, suggestJiraMatches } from './FeedbackAnalysisPanel';
import { matchRoadmap } from '../roadmapData';
import { monthKey as dataMonthKey, monthLabel as reportedMonthLabel } from '../data';
import SendToAdvisorButton from './SendToAdvisorButton';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Jira sprint names are "YYYY.MM MonthName ..." (e.g. "2026.09 September SIQ-L 1") — the leading
// numeric year.month is more reliable to parse than the trailing free-text sprint label.
function parseSprintDate(sprint) {
  const m = /^(\d{4})\.(\d{2})/.exec(sprint || '');
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) - 1 };
}

// Many tickets carry no Sprint value at all (never added to a sprint) but do carry a
// "release::<target>" label — "release::sept30", "release::oct", "release::backlog" — which is
// the team's real target-date signal for anything not yet slotted into a sprint. "backlog" means
// genuinely undated (caller falls back to the Planned bucket); everything else is a month name
// with an optional day, assumed to be the current year since that's all this board ever uses.
function parseReleaseLabel(release) {
  if (!release || release === 'backlog') return null;
  const m = /^([a-z]{3,})/i.exec(release);
  if (!m) return null;
  const idx = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
  if (idx == null) return null;
  return { year: new Date().getFullYear(), month: idx };
}

// Roadmap near-term item targets are "Oct 2026 (Q3)" or "Nov 2026".
function parseRoadmapTargetDate(target) {
  const m = /^([A-Za-z]+)\s+(\d{4})/.exec(target || '');
  if (!m) return null;
  const idx = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
  if (idx == null) return null;
  return { year: Number(m[2]), month: idx };
}

// Priority reflects how many distinct people independently raised this, not the topic itself —
// a complaint three people brought up separately is more urgent than a one-off, regardless of
// which sprint or roadmap area it lands in.
function priorityOf(reporterCount) {
  if (reporterCount >= 3) return 'High';
  if (reporterCount === 2) return 'Medium';
  return 'Low';
}

const PRIORITY_STYLE = {
  High: { color: '#b91c1c', background: '#fef2f2', border: '#fecaca', label: '❗ High' },
  Medium: { color: '#92400e', background: '#fffbeb', border: '#fde68a', label: '🟡 Medium' },
  Low: { color: '#374151', background: '#f3f4f6', border: '#e5e7eb', label: '⚪ Low' }
};

function PriorityTag({ priority }) {
  const s = PRIORITY_STYLE[priority];
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: s.color, background: s.background, border: `1px solid ${s.border}`, borderRadius: 12, padding: '2px 8px', whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
}

// AI dedup merges several raw entries into one group and picks the longest as `g.summary` —
// but the longest phrasing isn't always the one that happens to match a dated roadmap item or
// Jira ticket. Check every member's raw text, not just the representative, so a real match
// carried by a shorter member isn't silently lost. Collects EVERY ticket matched across all of
// those texts (not just the first hit) — a group's feedback can legitimately describe more than
// one real ticket's worth of problem, and all of them should get tagged.
function allJiraOrRoadmapMatches(summary, matched, jiraIssues) {
  const texts = [summary, ...matched.map(f => combinedText(f) || f.providerName || '')];
  const byKey = new Map();
  texts.forEach(t => {
    matchAllJiraIssues(t, jiraIssues).forEach(issue => {
      if (!byKey.has(issue.key)) byKey.set(issue.key, issue);
    });
  });
  const jiraMatches = Array.from(byKey.values());
  if (jiraMatches.length > 0) return { jiraMatches, roadmapMatch: null };
  let domainMatch = null;
  for (const t of texts) {
    const roadmapMatch = matchRoadmap(t);
    if (roadmapMatch && roadmapMatch.level === 'item') return { jiraMatches: [], roadmapMatch };
    if (roadmapMatch && roadmapMatch.level === 'domain' && !domainMatch) domainMatch = roadmapMatch;
  }
  return { jiraMatches: [], roadmapMatch: domainMatch };
}

// Buckets with no real calendar date behind them — these are exactly the ones a manual
// month override is allowed to act on. A dated Jira sprint/release or roadmap target already
// has a real answer for "when"; overriding those would fight the actual delivery signal instead
// of filling a gap in it.
const OVERRIDABLE_BUCKETS = new Set(['planned', 'jira-no-sprint', 'unscheduled']);

function monthLabel(key) {
  if (!key) return 'Not yet scheduled';
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m]} ${y}`;
}

// Rolling window of upcoming months for the override dropdown, encoded the same way classify()
// encodes a dated bucketKey ("YYYY-M0based") so an override slots into the exact same column
// logic as an automatically-derived date.
function nextMonthsOptions(count = 9) {
  const now = new Date();
  const opts = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
    opts.push({ value, label: monthLabel(value) });
  }
  return opts;
}

// Placement priority: an actual Jira ticket (and its sprint) beats a roadmap guess; a dated
// roadmap line item beats an undated domain match; domain-only and no-match both land outside
// the dated timeline since neither has a month to place them in. A manual override (set after
// the team discusses an undated item) takes priority over all of that, but only ever applies to
// the undated buckets above — it fills in a missing date, it doesn't second-guess a real one.
function classify(g, feedbackById, jiraIssues, overrides, fixedGroups, manualJiraLinks) {
  const matched = g.sourceIds.map(id => feedbackById.get(id)).filter(Boolean);
  const reporterCount = new Set(matched.map(f => (f.providerName || '').trim()).filter(Boolean)).size || 1;
  const priority = priorityOf(reporterCount);
  const groupKey = g.groupKey || g.sourceIds.slice().sort().join(',');

  // Every ticket a human explicitly linked to this exact group — via "+ Create Jira Story" or
  // by accepting an AI match suggestion — always wins over (and is merged with) the automatic
  // text-match: the team confirmed these are real. Each is stored under its own
  // `${groupKey}::${ticketKey}` key so a group can carry more than one, but entries also carry
  // `groupKey` directly so older single-link entries (stored under a bare groupKey) still match.
  // Prefers the live jiraIssues cache entry once a real sync pulls in its actual sprint/status;
  // falls back to what the create/link call captured until then.
  const manualLinksForGroup = Object.values(manualJiraLinks || {}).filter(e => e.groupKey === groupKey);
  const manualJiraMatches = manualLinksForGroup.map(link => (jiraIssues || []).find(j => j.key === link.key) || {
    key: link.key, summary: link.summary || g.summary, status: 'To Do',
    statusCategory: 'new', issueType: 'Story', parentKey: '', parentSummary: '',
    sprint: '', sprintState: '', release: '', labels: [], description: '', updated: link.createdAt
  });

  const auto = allJiraOrRoadmapMatches(g.summary, matched, jiraIssues);
  const roadmapMatch = manualJiraMatches.length > 0 ? null : auto.roadmapMatch;

  // Manual links first (so a human-confirmed link always places/labels the card, same as
  // before), then every automatic match not already covered by a manual one.
  const seenKeys = new Set(manualJiraMatches.map(m => m.key));
  const jiraMatches = [...manualJiraMatches, ...auto.jiraMatches.filter(m => !seenKeys.has(m.key))];
  const jiraMatch = jiraMatches[0] || null;

  let bucketKey, bucketLabel, sortKey, source;
  if (jiraMatch) {
    const d = parseSprintDate(jiraMatch.sprint) || parseReleaseLabel(jiraMatch.release);
    if (d) {
      bucketKey = `${d.year}-${String(d.month).padStart(2, '0')}`;
      bucketLabel = `${MONTHS[d.month]} ${d.year}`;
      sortKey = d.year * 12 + d.month;
    } else if (jiraMatch.release === 'backlog') {
      bucketKey = 'planned'; bucketLabel = 'Planned (not yet dated)'; sortKey = 9001;
    } else {
      bucketKey = 'jira-no-sprint'; bucketLabel = 'Jira ticket (no sprint set)'; sortKey = 9000;
    }
    source = { type: 'jira', jiraMatch, jiraMatches };
  } else if (roadmapMatch && roadmapMatch.level === 'item') {
    const d = parseRoadmapTargetDate(roadmapMatch.target);
    if (d) {
      bucketKey = `${d.year}-${String(d.month).padStart(2, '0')}`;
      bucketLabel = `${MONTHS[d.month]} ${d.year}`;
      sortKey = d.year * 12 + d.month;
    } else {
      bucketKey = 'planned'; bucketLabel = 'Planned (not yet dated)'; sortKey = 9001;
    }
    source = { type: 'roadmap-item', roadmapMatch };
  } else if (roadmapMatch && roadmapMatch.level === 'domain') {
    bucketKey = 'planned'; bucketLabel = 'Planned (not yet dated)'; sortKey = 9001;
    source = { type: 'roadmap-domain', roadmapMatch };
  } else {
    bucketKey = 'unscheduled'; bucketLabel = 'Not Yet Scheduled'; sortKey = 9002;
    source = { type: 'none' };
  }

  const overridable = OVERRIDABLE_BUCKETS.has(bucketKey);
  const overrideMonth = overridable ? (overrides || {})[groupKey] || null : null;
  if (overrideMonth) {
    bucketKey = overrideMonth;
    bucketLabel = monthLabel(overrideMonth);
    const [y, m] = overrideMonth.split('-').map(Number);
    sortKey = y * 12 + m;
  }

  const fixed = !!(fixedGroups || {})[groupKey];

  return { group: g, groupKey, matched, reporterCount, priority, bucketKey, bucketLabel, sortKey, source, overridable, overrideMonth, fixed };
}

function SourceTag({ source }) {
  if (source.type === 'jira') return <DeliveryBadges jiraMatches={source.jiraMatches || [source.jiraMatch]} roadmapMatch={null} />;
  if (source.type === 'roadmap-item' || source.type === 'roadmap-domain') {
    return <DeliveryBadges jiraMatch={null} roadmapMatch={source.roadmapMatch} />;
  }
  return (
    <div style={styles.noMatchBox}>
      <span style={styles.noMatchIcon}>ⓘ</span>
      <span>No matching ticket or roadmap item – needs manual triage</span>
    </div>
  );
}

// "Need improvement" feedback is anything actionable — a complaint or a request — same
// definition buildGroup already uses to decide whether a group gets routed to a pod at all
// (only Positive-sentiment groups are pure praise with nothing for a pod to act on).
function isActionable(g) {
  return g.sentiment !== 'Positive';
}

// Reuses the exact same done/in-progress/planned read as the DeliveryBadges pill so this
// dashboard's counts can never drift from what the badge on each card says — "not-addressed"
// is the one state DeliveryBadges doesn't need a word for, since it just renders nothing. A
// manual month override always reads as "planned" here — once the team has actually discussed
// and committed to a month for it, it's no longer "not yet addressed", regardless of what the
// underlying (or missing) Jira/roadmap signal said.
function careStatus(item) {
  // A manual "Mark Fixed" is the team's own on-the-ground confirmation — it outranks any
  // automatic Jira/roadmap/override read, the same way a person saying "this is done" should
  // beat an inferred guess.
  if (item.fixed) return 'done';
  if (item.overrideMonth) return 'planned';
  if (item.source.type === 'jira') return jiraStatusBucket(item.source.jiraMatch);
  if (item.source.type === 'roadmap-item' || item.source.type === 'roadmap-domain') return 'planned';
  return 'not-addressed';
}

// Timeline only ever shows actionable (complaint/request) feedback — see isActionable below —
// so a card that matched a ticket already marked Done, where that ticket hasn't been touched
// since BEFORE this feedback came in, is a real signal worth a human's attention: either the fix
// didn't actually land, or it regressed. A ticket updated AFTER the feedback's report date is
// much more likely the fix that's already addressing it, so that case is left alone.
function isPossibleRegression(item) {
  if (item.source.type !== 'jira' || !item.group.latestDate) return false;
  const matches = item.source.jiraMatches || (item.source.jiraMatch ? [item.source.jiraMatch] : []);
  const reportedAt = new Date(item.group.latestDate);
  return matches.some(m => m.updated && jiraStatusBucket(m) === 'done' && new Date(m.updated) < reportedAt);
}

const CARE_ORDER = ['done', 'in-progress', 'planned', 'not-addressed'];
const CARE_STYLE = {
  done: { color: '#059669', background: '#ecfdf5', border: '#a7f3d0', bar: '#10b981', label: '✓ Already Fixed' },
  'in-progress': { color: '#0369a1', background: '#eff6ff', border: '#bfdbfe', bar: '#0ea5e9', label: '🔧 Being Worked On' },
  planned: { color: '#92400e', background: '#fffbeb', border: '#fde68a', bar: '#f59e0b', label: '📅 Planned Ahead' },
  'not-addressed': { color: '#b91c1c', background: '#fef2f2', border: '#fecaca', bar: '#ef4444', label: '⚠️ Not Yet Addressed' }
};

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function matchedToText(item) {
  if (item.source.type === 'jira') {
    const matches = item.source.jiraMatches || (item.source.jiraMatch ? [item.source.jiraMatch] : []);
    return matches.map(m => `Jira ${m.key}: ${m.summary} (${m.status})`).join('; ');
  }
  if (item.source.type === 'roadmap-item' || item.source.type === 'roadmap-domain') {
    const m = item.source.roadmapMatch;
    return m ? (m.level === 'item' ? `Roadmap: ${m.name} (${m.target})` : `Roadmap domain: ${m.name}`) : '';
  }
  return 'No matching ticket or roadmap item';
}

function downloadCareCsv(status, items, feedbackById) {
  const header = ['Summary', 'Priority', 'Care Status', 'Timeline Bucket', 'Matched To', 'Reporter Name', 'Reporter Role', 'Region', 'Date', 'Feedback Detail'];
  const rows = [header];
  items.forEach(item => {
    const entries = (item.group.sourceIds || []).map(id => feedbackById[id]).filter(Boolean);
    const matchedTo = matchedToText(item);
    const base = [item.group.summary, item.priority || '', CARE_STYLE[status].label, item.bucketLabel, matchedTo];
    if (entries.length === 0) {
      rows.push([...base, '', '', '', '', '']);
    } else {
      entries.forEach(f => {
        rows.push([
          ...base,
          f.providerName || '',
          f.providerRole || '',
          f.region || '',
          f.date || '',
          [f.frictionPoints, f.notes].filter(Boolean).join(' | ')
        ]);
      });
    }
  });
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `timeline-${status}-feedback.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function CareDashboard({ classified, careFilter, onSelect, feedbackById }) {
  const actionable = useMemo(() => classified.filter(item => isActionable(item.group)), [classified]);
  if (actionable.length === 0) return null;

  const total = actionable.length;
  const counts = { done: 0, 'in-progress': 0, planned: 0, 'not-addressed': 0 };
  const reporters = { done: 0, 'in-progress': 0, planned: 0, 'not-addressed': 0 };
  actionable.forEach(item => {
    const status = careStatus(item);
    counts[status]++;
    reporters[status] += item.reporterCount;
  });

  // Clicking a card/segment a second time clears the filter — same toggle behavior everywhere
  // a filter chip normally works, so there's always an obvious way back to the full view.
  function toggle(k) {
    onSelect(careFilter === k ? null : k);
  }

  return (
    <div style={styles.dashboard}>
      <div style={styles.dashboardHeader}>
        <span style={{ fontWeight: 700, color: '#032D60' }}>Feedback Care Coverage</span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {total} actionable feedback point{total !== 1 ? 's' : ''} (complaints & requests, praise excluded) · click a category to filter
        </span>
      </div>
      <div style={styles.stackedBar}>
        {CARE_ORDER.filter(k => counts[k] > 0).map(k => (
          <div key={k}
            onClick={() => toggle(k)}
            title={`${CARE_STYLE[k].label}: ${counts[k]} of ${total} (${Math.round(counts[k] / total * 100)}%) — click to filter`}
            style={{
              flex: counts[k], background: CARE_STYLE[k].bar, cursor: 'pointer',
              opacity: careFilter && careFilter !== k ? 0.35 : 1
            }} />
        ))}
      </div>
      <div style={styles.dashboardCards}>
        {CARE_ORDER.map(k => (
          <div key={k}
            onClick={() => toggle(k)}
            style={{
              ...styles.careCard, background: CARE_STYLE[k].background,
              border: careFilter === k ? `2px solid ${CARE_STYLE[k].color}` : `1px solid ${CARE_STYLE[k].border}`,
              cursor: 'pointer', opacity: careFilter && careFilter !== k ? 0.5 : 1
            }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: CARE_STYLE[k].color }}>
              {counts[k]} <span style={{ fontSize: 12, fontWeight: 500 }}>({total ? Math.round(counts[k] / total * 100) : 0}%)</span>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: CARE_STYLE[k].color, marginTop: 2 }}>{CARE_STYLE[k].label}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              Raised by {reporters[k]} {reporters[k] === 1 ? 'person' : 'people'}
            </div>
          </div>
        ))}
      </div>
      {careFilter && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={() => onSelect(null)} style={styles.clearFilterBtn}>
            ✕ Clear filter ({CARE_STYLE[careFilter].label})
          </button>
          <button
            onClick={() => downloadCareCsv(careFilter, actionable.filter(item => careStatus(item) === careFilter), feedbackById)}
            style={styles.downloadCsvBtn}>
            ⬇ Download CSV ({counts[careFilter]})
          </button>
        </div>
      )}
    </div>
  );
}

const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const DATED_KEY_RE = /^\d{4}-\d{2}$/;

export default function TimelineView({ groups, feedbackById, jiraIssues, overrides, onOverride, suggestions, onSuggest, jiraSyncedAt, onRefresh, refreshing, refreshError, notes, onNote, onDump, fixedGroups, onMarkFixed, onUnmarkFixed, manualJiraLinks, onCreateJira, jiraMatchSuggestions, onJiraMatchSuggest, onAcceptJiraMatch }) {
  const [expanded, setExpanded] = useState(null);
  const [careFilter, setCareFilter] = useState(null);
  const [editingOverride, setEditingOverride] = useState(null);
  const [showDevLead, setShowDevLead] = useState(false);
  const [showSuggestionInbox, setShowSuggestionInbox] = useState(false);
  const [devLeadName, setDevLeadName] = useState('');
  const [reportedMonthFilter, setReportedMonthFilter] = useState('all');
  const [jiraTagFilter, setJiraTagFilter] = useState('all');
  const [fixVersionFilter, setFixVersionFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const suggestionMap = suggestions || {};
  const fetchingSuggestions = useRef(false);
  const jiraSuggestionMap = jiraMatchSuggestions || {};
  const fetchingJiraSuggestions = useRef(false);

  const monthOptions = useMemo(() => nextMonthsOptions(), []);

  const classified = useMemo(
    () => groups.map(g => classify(g, feedbackById, jiraIssues, overrides, fixedGroups, manualJiraLinks)),
    [groups, feedbackById, jiraIssues, overrides, fixedGroups, manualJiraLinks]
  );

  // Every not-yet-accepted, not-yet-dismissed AI suggestion across the whole timeline (not just
  // whatever month/fix-version filter happens to be selected) — so nothing sits unseen inside a
  // card the team never scrolls to. Mirrors the exact accept/dismiss conditions each per-card
  // banner already uses, just gathered into one list.
  const pendingSuggestions = useMemo(() => {
    const out = [];
    classified.forEach(item => {
      if (item.overridable && !item.overrideMonth) {
        const s = suggestionMap[item.groupKey];
        if (s?.month && !s.dismissed) out.push({ type: 'month', item, suggestion: s });
      }
      if (item.source.type === 'none') {
        const s = jiraSuggestionMap[item.groupKey];
        if (s?.matches?.length > 0 && !s.dismissed) out.push({ type: 'jira', item, suggestion: s });
      }
    });
    return out;
  }, [classified, suggestionMap, jiraSuggestionMap]);

  // Which month the underlying feedback was actually reported — same group.latestDate already
  // shown as the small date badge on each card — distinct from bucketKey/bucketLabel above,
  // which is when the *work* is scheduled/delivered, not when the feedback came in.
  const reportedMonthOptions = useMemo(() => {
    const keys = new Set(classified.map(item => dataMonthKey(item.group.latestDate)).filter(Boolean));
    return Array.from(keys).sort().reverse();
  }, [classified]);

  const reportedMonthFiltered = useMemo(
    () => (reportedMonthFilter === 'all' ? classified : classified.filter(item => dataMonthKey(item.group.latestDate) === reportedMonthFilter)),
    [classified, reportedMonthFilter]
  );

  // Options list is built off the month-filtered set so it only ever offers versions that
  // actually appear within whatever month is currently selected.
  const fixVersionOptions = useMemo(() => {
    const versions = new Set();
    reportedMonthFiltered.forEach(item => {
      const jiraMatches = item.source.type === 'jira' ? (item.source.jiraMatches || [item.source.jiraMatch]) : [];
      jiraMatches.forEach(m => splitFixVersions(m?.fixVersion).forEach(v => versions.add(v)));
    });
    return Array.from(versions).sort();
  }, [reportedMonthFiltered]);

  const fixVersionFiltered = useMemo(() => {
    if (fixVersionFilter === 'all') return reportedMonthFiltered;
    return reportedMonthFiltered.filter(item => {
      const jiraMatches = item.source.type === 'jira' ? (item.source.jiraMatches || [item.source.jiraMatch]) : [];
      return jiraMatches.some(m => splitFixVersions(m?.fixVersion).includes(fixVersionFilter));
    });
  }, [reportedMonthFiltered, fixVersionFilter]);

  // Count off the month+fix-version-filtered set (not the full list) so the toggle button's
  // own number always matches what clicking it would actually show.
  const untaggedCount = useMemo(
    () => fixVersionFiltered.filter(item => item.source.type !== 'jira').length,
    [fixVersionFiltered]
  );

  const tagFiltered = useMemo(
    () => (jiraTagFilter === 'untagged' ? fixVersionFiltered.filter(item => item.source.type !== 'jira') : fixVersionFiltered),
    [fixVersionFiltered, jiraTagFilter]
  );

  // Plain substring search across the summary, reporter details, and any tagged ticket keys —
  // "did we already see something about X" or "find the card for SEPSP-123" shouldn't require
  // scrolling through every bucket by hand.
  const filteredClassified = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tagFiltered;
    return tagFiltered.filter(item => {
      const jiraMatches = item.source.type === 'jira' ? (item.source.jiraMatches || [item.source.jiraMatch]) : [];
      const haystack = [
        item.group.summary,
        ...item.matched.map(f => `${f.providerName || ''} ${f.providerRole || ''} ${f.region || ''}`),
        ...jiraMatches.map(m => m.key)
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [tagFiltered, searchQuery]);

  // Real signal for the AI suggestion prompt: everything that already has an actual month,
  // whether from Jira/roadmap or a prior manual override — "this sounds like the thing already
  // scheduled for Oct" only works if the AI is shown what's scheduled for Oct.
  const datedContext = useMemo(
    () => classified
      .filter(item => DATED_KEY_RE.test(item.bucketKey))
      .map(item => ({ summary: item.group.summary, month: item.bucketLabel })),
    [classified]
  );

  // Undated items that either have never been asked, or whose summary changed since the cached
  // suggestion was made (dedup can reword a group's representative summary as new feedback rolls
  // in) — re-asking only these keeps a large undated backlog from re-costing an AI call on every
  // visit once it's already been covered.
  const needsSuggestion = useMemo(
    () => classified.filter(item => {
      if (!item.overridable || item.overrideMonth) return false;
      const cached = suggestionMap[item.groupKey];
      return !cached || cached.basis !== item.group.summary;
    }),
    [classified, suggestionMap]
  );

  useEffect(() => {
    if (needsSuggestion.length === 0 || fetchingSuggestions.current || !onSuggest) return;
    fetchingSuggestions.current = true;
    const requested = needsSuggestion.map(item => ({ groupKey: item.groupKey, text: item.group.summary }));
    suggestTimelineMonths(requested, datedContext, monthOptions)
      .then(results => {
        const byKey = new Map(results.map(r => [r.groupKey, r]));
        const patch = {};
        requested.forEach(it => {
          const r = byKey.get(it.groupKey);
          patch[it.groupKey] = { month: r?.month || null, reason: r?.reason || '', basis: it.text };
        });
        onSuggest(patch);
      })
      .catch(() => {})
      .finally(() => { fetchingSuggestions.current = false; });
  }, [needsSuggestion, datedContext, monthOptions, onSuggest]);

  // Only items with zero automatic signal (no Jira, no roadmap) are candidates for the AI
  // judge — anything already matched doesn't need a second opinion. Re-asked only when the
  // group's summary changed since the cached suggestion, same staleness check as the month
  // suggestion above.
  const needsJiraSuggestion = useMemo(
    () => classified.filter(item => {
      if (item.source.type !== 'none') return false;
      const cached = jiraSuggestionMap[item.groupKey];
      return !cached || cached.basis !== item.group.summary;
    }),
    [classified, jiraSuggestionMap]
  );

  useEffect(() => {
    if (needsJiraSuggestion.length === 0 || fetchingJiraSuggestions.current || !onJiraMatchSuggest) return;
    fetchingJiraSuggestions.current = true;
    const requested = needsJiraSuggestion.map(item => ({
      groupKey: item.groupKey,
      text: item.group.summary,
      candidates: jiraMatchCandidates(item.group.summary, jiraIssues)
    }));
    suggestJiraMatches(requested)
      .then(results => {
        const byKey = new Map(results.map(r => [r.groupKey, r]));
        const patch = {};
        requested.forEach(it => {
          const r = byKey.get(it.groupKey);
          patch[it.groupKey] = { matches: r?.matches || [], reason: r?.reason || '', basis: it.text };
        });
        onJiraMatchSuggest(patch);
      })
      .catch(() => {})
      .finally(() => { fetchingJiraSuggestions.current = false; });
  }, [needsJiraSuggestion, jiraIssues, onJiraMatchSuggest]);

  const buckets = useMemo(() => {
    const map = new Map();
    filteredClassified.forEach(item => {
      if (!map.has(item.bucketKey)) map.set(item.bucketKey, { label: item.bucketLabel, sortKey: item.sortKey, items: [] });
      map.get(item.bucketKey).items.push(item);
    });
    Array.from(map.values()).forEach(b => {
      // Priority, then how many people hit the same point, then — on a tie between both —
      // whichever came in most recently, so two equally-weighted items don't fall back to
      // arbitrary insertion order.
      b.items.sort((a, b2) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b2.priority]
        || b2.reporterCount - a.reporterCount
        || new Date(b2.group.latestDate || 0) - new Date(a.group.latestDate || 0));
    });
    return Array.from(map.values()).sort((a, b) => a.sortKey - b.sortKey);
  }, [filteredClassified]);

  // Filtering down to one care-status category re-derives each column's item list and
  // priority counts from scratch rather than reusing the unfiltered bucket totals, and drops
  // any column that ends up empty — so "Not Yet Addressed" shows exactly and only that.
  const visibleBuckets = useMemo(() => {
    return buckets
      .map(b => {
        const items = careFilter ? b.items.filter(item => careStatus(item) === careFilter) : b.items;
        const counts = { High: 0, Medium: 0, Low: 0 };
        items.forEach(i => { counts[i.priority]++; });
        return { ...b, items, counts };
      })
      .filter(b => b.items.length > 0);
  }, [buckets, careFilter]);

  const priorityCounts = useMemo(() => {
    const c = { High: 0, Medium: 0, Low: 0 };
    visibleBuckets.forEach(b => b.items.forEach(i => { c[i.priority]++; }));
    return c;
  }, [visibleBuckets]);

  const visibleTotal = priorityCounts.High + priorityCounts.Medium + priorityCounts.Low;

  // "Moved to In Development" reads as the same 'in-progress' care status the "Being Worked On"
  // column already shows — Jira's own statusCategory, not a guess at one specific status name, so
  // this can't drift out of sync with what the board (and this dashboard) already call "in dev".
  const inDevItems = useMemo(
    () => filteredClassified.filter(item => isActionable(item.group) && careStatus(item) === 'in-progress'),
    [filteredClassified]
  );

  // One digest of everything currently in development — a human picks who the Dev Lead is for
  // this send and clicks Send; nothing here fires automatically or per status change.
  function devLeadDigest(items) {
    const lines = [
      'Feedback items now In Development',
      `${items.length} item${items.length !== 1 ? 's' : ''} currently being worked on`
    ];
    items.slice(0, 12).forEach(item => {
      const jiraMatches = item.source.type === 'jira' ? (item.source.jiraMatches || [item.source.jiraMatch]) : [];
      const jiraMatch = jiraMatches[0] || null;
      const tags = [];
      if (jiraMatch?.priority) tags.push(`Priority: ${jiraMatch.priority}`);
      if (jiraMatch?.fixVersion) tags.push(`Fix Version: ${jiraMatch.fixVersion}`);
      const tagText = tags.length ? ` [${tags.join(', ')}]` : '';
      const keysText = jiraMatches.length > 0 ? ` (${jiraMatches.map(m => m.key).join(', ')})` : '';
      lines.push(`• ${item.group.summary}${keysText} — raised by ${item.reporterCount} ${item.reporterCount === 1 ? 'person' : 'people'}${tagText}`);
    });
    if (items.length > 12) lines.push(`…and ${items.length - 12} more`);
    return lines.join('\n');
  }

  if (groups.length === 0) return null;

  return (
    <div style={styles.box}>
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, color: '#032D60' }}>Delivery Timeline</span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={refreshing}
              style={{ ...styles.refreshBtn, opacity: refreshing ? 0.6 : 1, cursor: refreshing ? 'default' : 'pointer' }}
              title="Re-pull the latest sprint/status/release data from Jira for this timeline only"
            >
              {refreshing ? '⏳ Refreshing…' : '🔄 Refresh'}
            </button>
          )}
          {jiraSyncedAt && !refreshing && (
            <span style={{ fontSize: 11, color: '#9ca3af' }}>synced {new Date(jiraSyncedAt).toLocaleString()}</span>
          )}
        </div>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {careFilter && <>Showing {CARE_STYLE[careFilter].label} only · </>}
          {visibleTotal} point{visibleTotal !== 1 ? 's' : ''} · <span style={{ color: PRIORITY_STYLE.High.color }}>{priorityCounts.High} high</span> ·{' '}
          <span style={{ color: PRIORITY_STYLE.Medium.color }}>{priorityCounts.Medium} medium</span> ·{' '}
          <span style={{ color: PRIORITY_STYLE.Low.color }}>{priorityCounts.Low} low</span> priority
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' }}>
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="🔎 Search summary, reporter, ticket key…"
          style={styles.searchInput}
        />
        <select value={reportedMonthFilter} onChange={e => setReportedMonthFilter(e.target.value)} style={styles.monthSelect}>
          <option value="all">All months</option>
          {reportedMonthOptions.map(key => (
            <option key={key} value={key}>{reportedMonthLabel(key)}</option>
          ))}
        </select>
        <button
          onClick={() => setJiraTagFilter(f => (f === 'untagged' ? 'all' : 'untagged'))}
          style={jiraTagFilter === 'untagged' ? styles.jiraFilterBtnActive : styles.jiraFilterBtn}
        >
          🚫 No Jira ticket ({untaggedCount})
        </button>
        {fixVersionOptions.length > 0 && (
          <select value={fixVersionFilter} onChange={e => setFixVersionFilter(e.target.value)} style={styles.monthSelect}>
            <option value="all">All fix versions</option>
            {fixVersionOptions.map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        )}
      </div>
      {refreshError && <div style={styles.refreshError}>⚠️ Jira refresh failed: {refreshError}</div>}
      {pendingSuggestions.length > 0 && (
        <div style={{ ...styles.card, marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
            onClick={() => setShowSuggestionInbox(v => !v)}>
            <span style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>
              Review AI Suggestions <span style={{ fontWeight: 400, fontSize: 13, color: '#6b7280' }}>({pendingSuggestions.length} pending)</span>
            </span>
            <span style={{ color: '#9ca3af', fontSize: 18 }}>{showSuggestionInbox ? '▲' : '▼'}</span>
          </div>
          {showSuggestionInbox && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
                Every AI month and Jira-match suggestion still waiting on a human call, gathered in one place regardless of which filter is active below.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => pendingSuggestions.forEach(({ type, item, suggestion }) => type === 'month'
                    ? (onOverride && onOverride(item.groupKey, suggestion.month))
                    : (onAcceptJiraMatch && onAcceptJiraMatch(item.groupKey, item.group, suggestion.matches)))}
                  style={styles.suggestionAcceptBtn}
                >
                  Accept all
                </button>
                <button
                  onClick={() => {
                    const monthPatch = {}, jiraPatch = {};
                    pendingSuggestions.forEach(({ type, item, suggestion }) => {
                      if (type === 'month') monthPatch[item.groupKey] = { ...suggestion, dismissed: true };
                      else jiraPatch[item.groupKey] = { ...suggestion, dismissed: true };
                    });
                    if (Object.keys(monthPatch).length) onSuggest && onSuggest(monthPatch);
                    if (Object.keys(jiraPatch).length) onJiraMatchSuggest && onJiraMatchSuggest(jiraPatch);
                  }}
                  style={styles.suggestionDismissBtn}
                >
                  Dismiss all
                </button>
              </div>
              {pendingSuggestions.map(({ type, item, suggestion }) => (
                <div key={`${type}-${item.groupKey}`} style={styles.inboxRow}>
                  <p style={styles.inboxSummary}>{item.group.summary}</p>
                  <div style={styles.suggestionBanner}>
                    <div style={styles.suggestionText}>
                      {type === 'month'
                        ? <>💡 AI suggests <strong>{monthLabel(suggestion.month)}</strong></>
                        : <>🤖 AI suggests {suggestion.matches.length > 1 ? 'tickets' : 'ticket'} <strong>{suggestion.matches.join(', ')}</strong></>}
                      {suggestion.reason ? ` — ${suggestion.reason}` : ''}
                    </div>
                    <button
                      onClick={() => type === 'month'
                        ? (onOverride && onOverride(item.groupKey, suggestion.month))
                        : (onAcceptJiraMatch && onAcceptJiraMatch(item.groupKey, item.group, suggestion.matches))}
                      style={styles.suggestionAcceptBtn}
                    >
                      Accept {type === 'jira' && suggestion.matches.length > 1 ? 'all' : ''}
                    </button>
                    <button
                      onClick={() => type === 'month'
                        ? (onSuggest && onSuggest({ [item.groupKey]: { ...suggestion, dismissed: true } }))
                        : (onJiraMatchSuggest && onJiraMatchSuggest({ [item.groupKey]: { ...suggestion, dismissed: true } }))}
                      style={styles.suggestionDismissBtn}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <CareDashboard classified={filteredClassified} careFilter={careFilter} onSelect={setCareFilter} feedbackById={feedbackById} />
      {inDevItems.length > 0 && (
        <div style={{ ...styles.card, marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
            onClick={() => setShowDevLead(v => !v)}>
            <span style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>
              Dev Lead Notification <span style={{ fontWeight: 400, fontSize: 13, color: '#6b7280' }}>({inDevItems.length} in development)</span>
            </span>
            <span style={{ color: '#9ca3af', fontSize: 18 }}>{showDevLead ? '▲' : '▼'}</span>
          </div>
          {showDevLead && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
                Everything currently "Being Worked On" — pick who the Dev Lead is for this send and click Send. One digest, sent whenever you choose. Nothing here sends on its own.
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={devLeadName} onChange={e => setDevLeadName(e.target.value)} style={styles.assigneeSelect}>
                  <option value="">Select Dev Lead…</option>
                  {ASSIGNABLE_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
                {devLeadName && (
                  <SendToAdvisorButton advisorName={devLeadName} email={PEOPLE_EMAILS[devLeadName]} message={devLeadDigest(inDevItems)} />
                )}
              </div>
            </div>
          )}
        </div>
      )}
      <div style={styles.row}>
        {visibleBuckets.map(b => (
          <div key={b.label} style={styles.column}>
            <div style={styles.columnHeader}>
              <div>{b.label} <span style={styles.count}>{b.items.length}</span></div>
              <div style={styles.columnCounts}>
                <span style={{ color: PRIORITY_STYLE.High.color }}>{b.counts.High} high</span>
                <span style={{ color: '#d1d5db' }}> · </span>
                <span style={{ color: PRIORITY_STYLE.Medium.color }}>{b.counts.Medium} medium</span>
                <span style={{ color: '#d1d5db' }}> · </span>
                <span style={{ color: PRIORITY_STYLE.Low.color }}>{b.counts.Low} low</span>
              </div>
            </div>
            <div style={styles.columnBody}>
              {b.items.map(item => {
                const key = `${b.label}-${item.group.sourceIds.join(',')}`;
                const isOpen = expanded === key;
                return (
                  <div key={key} style={styles.card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                      <PriorityTag priority={item.priority} />
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {item.group.latestDate && (
                          <span style={styles.datePill}>
                            📅 {monthLabel(dataMonthKey(item.group.latestDate))}
                          </span>
                        )}
                        <span style={styles.peoplePill}>👥 {item.reporterCount}</span>
                      </div>
                    </div>
                    <p style={styles.summary}>{item.group.summary}</p>
                    <SourceTag source={item.source} />
                    {isPossibleRegression(item) && (
                      <div style={styles.regressionBanner}>
                        ⚠️ Possible regression — the linked ticket was already marked Done before this feedback came in
                      </div>
                    )}
                    {item.source.type === 'none' && jiraSuggestionMap[item.groupKey]?.matches?.length > 0 && !jiraSuggestionMap[item.groupKey]?.dismissed && (
                      <div style={styles.suggestionBanner}>
                        <div style={styles.suggestionText}>
                          🤖 AI suggests {jiraSuggestionMap[item.groupKey].matches.length > 1 ? 'tickets' : 'ticket'}{' '}
                          <strong>{jiraSuggestionMap[item.groupKey].matches.join(', ')}</strong>
                          {jiraSuggestionMap[item.groupKey].reason ? ` — ${jiraSuggestionMap[item.groupKey].reason}` : ''}
                        </div>
                        <button
                          onClick={() => onAcceptJiraMatch && onAcceptJiraMatch(item.groupKey, item.group, jiraSuggestionMap[item.groupKey].matches)}
                          style={styles.suggestionAcceptBtn}
                        >
                          Accept {jiraSuggestionMap[item.groupKey].matches.length > 1 ? 'all' : ''}
                        </button>
                        <button
                          onClick={() => onJiraMatchSuggest && onJiraMatchSuggest({ [item.groupKey]: { ...jiraSuggestionMap[item.groupKey], dismissed: true } })}
                          style={styles.suggestionDismissBtn}
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                    {item.source.type !== 'jira' && onCreateJira && (
                      <CreateJiraButton item={item} onCreateJira={onCreateJira} />
                    )}
                    {item.fixed && onUnmarkFixed && (
                      <div style={styles.fixedBadgeRow}>
                        <span style={styles.fixedBadge}>✓ Manually marked fixed</span>
                        <button onClick={() => onUnmarkFixed(item.groupKey)} style={styles.fixedUndoBtn}>Undo</button>
                      </div>
                    )}
                    {!item.fixed && onMarkFixed && careStatus(item) !== 'done' && (
                      <MarkFixedControl item={item} onMarkFixed={onMarkFixed} />
                    )}
                    {item.overridable && !item.overrideMonth && suggestionMap[item.groupKey]?.month && !suggestionMap[item.groupKey]?.dismissed && (
                      <div style={styles.suggestionBanner}>
                        <div style={styles.suggestionText}>
                          💡 AI suggests <strong>{monthLabel(suggestionMap[item.groupKey].month)}</strong>
                          {suggestionMap[item.groupKey].reason ? ` — ${suggestionMap[item.groupKey].reason}` : ''}
                        </div>
                        <button
                          onClick={() => onOverride && onOverride(item.groupKey, suggestionMap[item.groupKey].month)}
                          style={styles.suggestionAcceptBtn}
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => onSuggest && onSuggest({ [item.groupKey]: { ...suggestionMap[item.groupKey], dismissed: true } })}
                          style={styles.suggestionDismissBtn}
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                    {item.overridable && item.overrideMonth && editingOverride !== item.groupKey && (
                      <div style={styles.overrideRow}>
                        <span style={styles.overrideBadge}>📌 Manually scheduled for {item.bucketLabel}</span>
                        <button onClick={() => setEditingOverride(item.groupKey)} style={styles.overrideChangeBtn}>Change</button>
                      </div>
                    )}
                    {item.overridable && (!item.overrideMonth || editingOverride === item.groupKey) && (
                      <div style={styles.moveBox}>
                        <div style={styles.sectionHeader}>
                          📅 {item.overrideMonth ? 'Change scheduled month' : 'Move to a month after discussion'}
                        </div>
                        <select
                          value={item.overrideMonth || ''}
                          onChange={e => {
                            onOverride && onOverride(item.groupKey, e.target.value || null);
                            setEditingOverride(null);
                          }}
                          style={styles.overrideSelect}
                        >
                          <option value="">— Not yet scheduled —</option>
                          {monthOptions.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {item.overridable && (onNote || onDump) && (
                      <TimelineNoteAndDump
                        item={item}
                        note={(notes || {})[item.groupKey] || ''}
                        onNote={onNote}
                        onDump={onDump}
                      />
                    )}
                    <button onClick={() => setExpanded(isOpen ? null : key)} style={styles.expandBtn}>
                      {isOpen ? 'Hide detail ▲' : 'Show detail ▼'}
                    </button>
                    {isOpen && (
                      <div style={styles.detail}>
                        {item.matched.map(f => (
                          <div key={f.id} style={styles.sourceRow}>
                            <strong>{f.providerName}</strong>
                            {f.providerRole && <span style={{ color: '#6b7280' }}> · {f.providerRole}</span>}
                            <div style={{ color: '#374151', marginTop: 2 }}>{feedbackDetailText(f)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Rendered on anything without an actual Jira ticket yet — fully unmatched groups, and ones that
// only matched a roadmap line item/domain (a conceptual "where this fits" with nothing tracking
// it in Jira). Either way there's no real ticket, so a story can be spun up directly from the
// feedback that raised it instead of the team having to do it by hand.
const ASSIGNABLE_NAMES = Object.keys(PEOPLE_EMAILS).sort();

function CreateJiraButton({ item, onCreateJira }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const [showPopup, setShowPopup] = useState(false);
  const [assigneeName, setAssigneeName] = useState('');

  async function handleClick() {
    setCreating(true);
    setError(null);
    try {
      const assigneeEmail = assigneeName ? PEOPLE_EMAILS[assigneeName] : null;
      const result = await onCreateJira(item.groupKey, item.group, assigneeEmail);
      setCreated({ ...result, assigneeName: assigneeName || null });
      setShowPopup(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <div style={styles.createJiraBox}>
        {created ? (
          <span style={styles.createJiraDone}>✓ Created {created.key}</span>
        ) : (
          <>
            <select value={assigneeName} onChange={e => setAssigneeName(e.target.value)} style={styles.assigneeSelectFull}>
              <option value="">👤 Assign to… (optional)</option>
              {ASSIGNABLE_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            <button onClick={handleClick} disabled={creating} style={{ ...styles.createJiraBtnFull, opacity: creating ? 0.6 : 1 }}>
              {creating ? '⏳ Creating…' : '+ Create Jira Story'}
            </button>
          </>
        )}
        {error && <span style={styles.createJiraError}>⚠️ {error}</span>}
      </div>
      {showPopup && created && (
        <div style={styles.jiraPopupOverlay} onClick={() => setShowPopup(false)}>
          <div style={styles.jiraPopupBox} onClick={e => e.stopPropagation()}>
            <div style={styles.jiraPopupIcon}>✓</div>
            <h3 style={styles.jiraPopupTitle}>Story Created in Jira</h3>
            <p style={styles.jiraPopupSummary}>{created.issue?.summary}</p>
            <div style={styles.jiraPopupDetails}>
              <div style={styles.jiraPopupRow}>
                <span style={styles.jiraPopupRowLabel}>Ticket Number</span>
                <span style={styles.jiraPopupRowValue}>{created.key}</span>
              </div>
              <div style={styles.jiraPopupRow}>
                <span style={styles.jiraPopupRowLabel}>Project</span>
                <span style={styles.jiraPopupRowValue}>{created.key.split('-')[0]}</span>
              </div>
              <div style={styles.jiraPopupRow}>
                <span style={styles.jiraPopupRowLabel}>Issue Type</span>
                <span style={styles.jiraPopupRowValue}>{created.issue?.issueType}</span>
              </div>
              <div style={styles.jiraPopupRow}>
                <span style={styles.jiraPopupRowLabel}>Status</span>
                <span style={styles.jiraPopupRowValue}>{created.issue?.status}</span>
              </div>
              <div style={styles.jiraPopupRow}>
                <span style={styles.jiraPopupRowLabel}>Assigned To</span>
                <span style={styles.jiraPopupRowValue}>{created.assignee || (created.assigneeName ? '⚠️ Not set (see warning below)' : 'Unassigned')}</span>
              </div>
              <div style={styles.jiraPopupRow}>
                <span style={styles.jiraPopupRowLabel}>Sprint</span>
                <span style={styles.jiraPopupRowValue}>{created.issue?.sprint || (created.sprintWarning ? '⚠️ Not set (see warning below)' : 'Backlog')}</span>
              </div>
              <div style={styles.jiraPopupRow}>
                <span style={styles.jiraPopupRowLabel}>Location</span>
                <span style={{ ...styles.jiraPopupRowValue, wordBreak: 'break-all', fontWeight: 500 }}>{created.url}</span>
              </div>
            </div>
            {created.assigneeWarning && (
              <p style={{ fontSize: 12, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 10px', marginTop: 10 }}>
                ⚠️ {created.assigneeWarning}
              </p>
            )}
            {created.sprintWarning && (
              <p style={{ fontSize: 12, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 10px', marginTop: 10 }}>
                ⚠️ {created.sprintWarning}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
              <a href={created.url} target="_blank" rel="noopener noreferrer" style={styles.jiraPopupOpenBtn}>
                Open in Jira ↗
              </a>
              <button onClick={() => setShowPopup(false)} style={styles.jiraPopupCloseBtn}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Rendered on every card whose care status isn't already "Already Fixed" — a manual confirmation
// that the team actually resolved this, independent of whatever Jira/roadmap/override status it
// currently reads as. Recheck the Care Coverage percentages: they read careStatus() live off
// fixedGroups, so marking one fixed here immediately moves its count into "Already Fixed".
function MarkFixedControl({ item, onMarkFixed }) {
  const [note, setNote] = useState('');
  return (
    <div style={styles.fixedBlock}>
      <div style={styles.sectionHeaderGreen}>✓ Resolution</div>
      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Note on how this was fixed…"
        style={styles.fixedTextarea}
      />
      <button onClick={() => onMarkFixed(item.groupKey, item.group, note)} style={styles.fixedBtn}>
        ✓ Mark Fixed
      </button>
    </div>
  );
}

// Only rendered for the three undated buckets (Not Yet Scheduled, Planned, Jira ticket with no
// sprint) — these are exactly the items still being triaged, where a discussion note or a "this
// turned out not to need action" call actually applies. Dated/Jira-matched items already have a
// definite status, so this UI would just be noise there.
function TimelineNoteAndDump({ item, note, onNote, onDump }) {
  const [draft, setDraft] = useState(note || '');
  const dirty = draft !== (note || '');
  return (
    <div style={styles.noteBlock}>
      {onNote && (
        <>
          <div style={styles.sectionHeader}>📄 Additional Notes</div>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Discussion notes for this item…"
            style={styles.noteTextarea}
          />
        </>
      )}
      <div style={styles.footerRow}>
        {onDump && (
          <button
            onClick={() => onDump(item.groupKey, item.group, item.bucketLabel)}
            style={styles.dumpBtn}
            title="Not actually actionable — moves this out of Needs Improvement/Timeline into the Dumped tab"
          >
            🗑 Remove
          </button>
        )}
        {onNote && (
          <button
            onClick={() => onNote(item.groupKey, draft)}
            disabled={!dirty}
            style={{ ...styles.saveNoteBtn, opacity: dirty ? 1 : 0.5, cursor: dirty ? 'pointer' : 'default' }}
          >
            {dirty ? '💾 Save' : '✓ Saved'}
          </button>
        )}
      </div>
    </div>
  );
}

export { monthLabel, classify, careStatus, CARE_STYLE };

const styles = {
  box: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '16px 18px', marginBottom: 20 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 6 },
  refreshBtn: { fontSize: 11.5, fontWeight: 600, color: '#0176D3', background: '#fff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '3px 10px' },
  refreshError: { fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 10px', marginBottom: 12 },
  dashboard: { marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid #e5e7eb' },
  dashboardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap', gap: 6 },
  stackedBar: { display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden', marginBottom: 10, background: '#f3f4f6' },
  dashboardCards: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  careCard: { flex: '1 1 140px', minWidth: 140, borderRadius: 8, padding: '10px 12px' },
  clearFilterBtn: { background: 'transparent', color: '#0176D3', border: '1px solid #bfdbfe', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  downloadCsvBtn: { background: '#0176D3', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  row: { display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 4 },
  column: { flex: '0 0 260px', minWidth: 260 },
  columnHeader: { fontWeight: 700, fontSize: 13, color: '#1f2937', marginBottom: 8, paddingBottom: 6, borderBottom: '2px solid #e5e7eb' },
  count: { fontWeight: 500, color: '#6b7280', marginLeft: 4 },
  columnCounts: { fontWeight: 500, fontSize: 11, marginTop: 3 },
  columnBody: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 520, overflowY: 'auto', paddingRight: 4 },
  card: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 12px' },
  summary: { fontSize: 12.5, color: '#1f2937', lineHeight: 1.4, marginBottom: 6 },
  datePill: { fontSize: 11, fontWeight: 600, background: '#fef9c3', color: '#854d0e', padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap' },
  peoplePill: { fontSize: 11, fontWeight: 600, color: '#374151', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 10, padding: '2px 8px' },
  noMatchBox: { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11, color: '#6b7280', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, padding: '7px 9px', marginTop: 4 },
  noMatchIcon: { flexShrink: 0, color: '#9ca3af' },
  sectionHeader: { fontSize: 11, fontWeight: 700, color: '#92400e', marginBottom: 6 },
  sectionHeaderGreen: { fontSize: 11, fontWeight: 700, color: '#059669', marginBottom: 6 },
  overrideRow: { marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  overrideLabel: { display: 'block', fontSize: 10.5, color: '#92400e', fontWeight: 600, marginBottom: 4, width: '100%' },
  overrideSelect: { width: '100%', fontSize: 11.5, padding: '4px 6px', borderRadius: 5, border: '1px solid #d1d5db', background: '#fff', color: '#1f2937' },
  moveBox: { marginTop: 8, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 9px' },
  noteBlock: { marginTop: 8, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 9px' },
  noteLabel: { display: 'block', fontSize: 10.5, color: '#6b7280', fontWeight: 600, marginBottom: 4 },
  noteTextarea: { width: '100%', fontSize: 11.5, padding: '5px 7px', borderRadius: 5, border: '1px solid #d1d5db', background: '#fff', color: '#1f2937', resize: 'vertical', minHeight: 44, fontFamily: 'inherit' },
  footerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8 },
  dumpBtn: { fontSize: 11, fontWeight: 600, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 5, padding: '5px 11px', cursor: 'pointer' },
  saveNoteBtn: { fontSize: 11, fontWeight: 600, color: '#fff', background: '#0176D3', border: 'none', borderRadius: 5, padding: '5px 12px' },
  fixedBlock: { marginTop: 8, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 6, padding: '8px 9px', display: 'flex', flexDirection: 'column', gap: 6 },
  fixedTextarea: { width: '100%', fontSize: 11.5, padding: '5px 7px', borderRadius: 5, border: '1px solid #d1d5db', background: '#fff', color: '#1f2937', resize: 'vertical', minHeight: 36, fontFamily: 'inherit' },
  fixedBtn: { fontSize: 11, fontWeight: 600, color: '#059669', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 5, padding: '4px 9px', cursor: 'pointer', alignSelf: 'flex-start' },
  fixedBadgeRow: { marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  fixedBadge: { fontSize: 11, fontWeight: 600, color: '#059669', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 12, padding: '2px 8px' },
  fixedUndoBtn: { fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 },
  createJiraRow: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  createJiraBox: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '8px 9px' },
  createJiraBtn: { fontSize: 11, fontWeight: 600, color: '#0176D3', background: '#fff', border: '1px solid #bfdbfe', borderRadius: 5, padding: '4px 9px', cursor: 'pointer' },
  createJiraBtnFull: { width: '100%', fontSize: 12, fontWeight: 700, color: '#fff', background: '#0176D3', border: 'none', borderRadius: 5, padding: '7px 9px', cursor: 'pointer' },
  assigneeSelect: { fontSize: 11, border: '1px solid #d1d5db', borderRadius: 5, padding: '3px 6px', color: '#374151', background: '#fff' },
  assigneeSelectFull: { width: '100%', fontSize: 11.5, border: '1px solid #d1d5db', borderRadius: 5, padding: '6px 7px', color: '#374151', background: '#fff' },
  monthSelect: { fontSize: 13, color: '#374151', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' },
  searchInput: { fontSize: 13, color: '#374151', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 10px', minWidth: 220 },
  jiraFilterBtn: { fontSize: 13, fontWeight: 600, color: '#374151', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap' },
  jiraFilterBtnActive: { fontSize: 13, fontWeight: 600, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap' },
  createJiraError: { fontSize: 11, color: '#b91c1c' },
  createJiraDone: { fontSize: 11, fontWeight: 600, color: '#059669' },
  jiraPopupOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 },
  jiraPopupBox: { background: '#fff', borderRadius: 12, padding: '28px 32px', width: 380, maxWidth: '90vw', textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' },
  jiraPopupIcon: { width: 44, height: 44, borderRadius: '50%', background: '#ecfdf5', color: '#059669', fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' },
  jiraPopupTitle: { fontSize: 16, fontWeight: 700, color: '#032D60', margin: '0 0 8px' },
  jiraPopupKey: { fontSize: 14, fontWeight: 700, color: '#0176D3', margin: '0 0 6px' },
  jiraPopupSummary: { fontSize: 12.5, color: '#6b7280', margin: '0 0 14px', lineHeight: 1.4 },
  jiraPopupDetails: { display: 'flex', flexDirection: 'column', gap: 8, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', textAlign: 'left' },
  jiraPopupRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
  jiraPopupRowLabel: { fontSize: 11, color: '#6b7280', fontWeight: 600, flexShrink: 0 },
  jiraPopupRowValue: { fontSize: 12.5, color: '#032D60', fontWeight: 700, textAlign: 'right' },
  jiraPopupOpenBtn: { fontSize: 13, fontWeight: 600, color: '#fff', background: '#0176D3', border: 'none', borderRadius: 6, padding: '8px 16px', textDecoration: 'none', display: 'inline-block' },
  jiraPopupCloseBtn: { fontSize: 13, fontWeight: 600, color: '#374151', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 16px', cursor: 'pointer' },
  overrideBadge: { fontSize: 11, fontWeight: 600, color: '#92400e' },
  overrideChangeBtn: { flexShrink: 0, fontSize: 11, color: '#0176D3', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' },
  suggestionBanner: { marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 5, padding: '5px 8px' },
  suggestionText: { fontSize: 11, color: '#0369a1', lineHeight: 1.4 },
  suggestionAcceptBtn: { flexShrink: 0, fontSize: 11, fontWeight: 600, color: '#fff', background: '#0176D3', border: 'none', borderRadius: 4, padding: '3px 9px', cursor: 'pointer' },
  suggestionDismissBtn: { flexShrink: 0, fontSize: 11, fontWeight: 600, color: '#6b7280', background: '#fff', border: '1px solid #d1d5db', borderRadius: 4, padding: '3px 9px', cursor: 'pointer' },
  regressionBanner: { marginTop: 8, fontSize: 11, fontWeight: 600, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 5, padding: '5px 8px' },
  inboxRow: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 12px' },
  inboxSummary: { fontSize: 12.5, color: '#1f2937', lineHeight: 1.4, margin: '0 0 2px' },
  expandBtn: { fontSize: 11, color: '#0176D3', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0 0', textAlign: 'left' },
  detail: { marginTop: 8, paddingTop: 8, borderTop: '1px solid #e5e7eb' },
  sourceRow: { fontSize: 12, marginBottom: 6 }
};
