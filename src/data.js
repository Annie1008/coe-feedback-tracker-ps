export const REGIONS = [
  'Global', 'REG', 'LATAM', 'TMT/CBS', 'PACE', 'PubSec',
  'APAC ANZ', 'APAC ASEAN', 'APAC Japan',
  'EMEA UK', 'EMEA N & Cen', 'EMEA S & France'
];

export const FEEDBACK_FORMATS = [
  'Video Call', 'Phone Call', 'Slack', 'In-Person', 'Other'
];

export const OU_ENABLEMENT_FORMATS = [
  'All-Hands', '1:1 Call', 'Team Call', 'Webinar', 'Slack', 'Email', 'In-Person Training', 'Other'
];

export const ROLES = [
  'VP', 'Advisor', 'Workstream Lead', 'Scoper', 'Delivery Manager', 'AE', 'SE', 'Other'
];

export const SYNTHESIS_PROMPTS = [
  { key: 'friction', label: 'Friction Map Analysis', description: 'Identify top friction points, root causes, and field behaviors they drive.' },
  { key: 'shadow_it', label: 'Shadow IT Inventory', description: 'Identify workarounds and shadow tools. Flag genuine innovation vs risk.' },
  { key: 'exec_summary', label: 'Executive Summary Draft', description: 'Draft a field friction report executive summary for a VP of ProServ.' },
  { key: 'coaching', label: 'Coaching Script', description: 'Generate a 1-on-1 coaching script based on patterns in field data.' },
  { key: 'quotes', label: 'Field Voice Quotes', description: 'Extract and curate the most impactful direct quotes.' },
  { key: 'custom', label: 'Custom Prompt', description: 'Write your own prompt. Field input data will be included automatically.' }
];

const STORAGE_KEY = 'coe_tracker_data';

const DEFAULT_INITIATIVES = [
  { id: '1', name: 'SolutionIQ', description: 'AI-powered solution intelligence for field teams.', rolloutDate: '', color: '#0176D3' },
  { id: '2', name: 'Risk Agent', description: 'Automated risk identification and mitigation guidance.', rolloutDate: '', color: '#1B96FF' },
  { id: '3', name: 'Solution Methodology', description: 'Standardized scoping and delivery methodology.', rolloutDate: '', color: '#0D7DBF' },
  { id: '4', name: 'Quantum Leap', description: 'Next-generation productivity accelerators for Advisors.', rolloutDate: '', color: '#032D60' }
];

const DEFAULT_DATA = { initiatives: DEFAULT_INITIATIVES.map(i => ({ ...i })), feedback: [], closedLoop: {}, podNotes: {}, podAssignments: {}, jiraIssues: [], jiraSyncedAt: null, timelineOverrides: {}, timelineSuggestions: {}, timelineHistory: [], timelineNotes: {}, dumpedGroups: {} };

const API_BASE = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001';

// Callback that App.js registers to show a save-failure warning in the UI
let _onSaveError = null;
export function onSaveError(fn) { _onSaveError = fn; }

// Merge two datasets together — unions feedback by ID, merges closedLoop,
// and takes the most recent initiatives list. This means no user's records
// can ever be wiped by another user's save.
function mergeData(base, incoming) {
  const feedbackMap = new Map();
  (base.feedback || []).forEach(f => feedbackMap.set(f.id, f));
  // incoming takes precedence for the same ID (it's the most recent edit)
  (incoming.feedback || []).forEach(f => feedbackMap.set(f.id, f));

  return {
    // Use whichever initiatives list is more recent
    initiatives: (incoming._savedAt || 0) >= (base._savedAt || 0)
      ? (incoming.initiatives || base.initiatives)
      : (base.initiatives || incoming.initiatives),
    feedback: Array.from(feedbackMap.values()),
    closedLoop: { ...(base.closedLoop || {}), ...(incoming.closedLoop || {}) },
    podNotes: { ...(base.podNotes || {}), ...(incoming.podNotes || {}) },
    podAssignments: { ...(base.podAssignments || {}), ...(incoming.podAssignments || {}) },
    // Jira import replaces wholesale (not merged field-by-field) — a re-export reflects the
    // current true state of the backlog, including tickets that moved or disappeared, so
    // whichever save is newer should win outright rather than union with a stale snapshot.
    jiraIssues: (incoming._savedAt || 0) >= (base._savedAt || 0)
      ? (incoming.jiraIssues || base.jiraIssues || [])
      : (base.jiraIssues || incoming.jiraIssues || []),
    jiraSyncedAt: (incoming._savedAt || 0) >= (base._savedAt || 0)
      ? (incoming.jiraSyncedAt || base.jiraSyncedAt || null)
      : (base.jiraSyncedAt || incoming.jiraSyncedAt || null),
    // Manual month placements and their AI suggestions — merged per-key like closedLoop/podNotes
    // above, so one person setting an override for group X can never wipe out another person's
    // override for group Y that was saved around the same time.
    timelineOverrides: { ...(base.timelineOverrides || {}), ...(incoming.timelineOverrides || {}) },
    timelineSuggestions: { ...(base.timelineSuggestions || {}), ...(incoming.timelineSuggestions || {}) },
    timelineNotes: { ...(base.timelineNotes || {}), ...(incoming.timelineNotes || {}) },
    dumpedGroups: { ...(base.dumpedGroups || {}), ...(incoming.dumpedGroups || {}) },
    // Append-only log of manual month reassignments — union by entry id (like feedback above)
    // so two tabs logging different moves around the same time both survive the merge.
    timelineHistory: Array.from(
      new Map([...(base.timelineHistory || []), ...(incoming.timelineHistory || [])].map(h => [h.id, h])).values()
    ),
    _savedAt: Math.max(incoming._savedAt || 0, base._savedAt || 0)
  };
}

function loadLocalData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.initiatives)) return parsed;
    }
  } catch {}
  return { ...DEFAULT_DATA, initiatives: DEFAULT_INITIATIVES.map(i => ({ ...i })) };
}

export async function loadData() {
  const local = loadLocalData();
  try {
    const res = await fetch(`${API_BASE}/api/data`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = await res.json();
    if (remote && Array.isArray(remote.initiatives) && remote.initiatives.length > 0) {
      // Always merge local + remote so no records from either side are lost
      const merged = mergeData(remote, local);

      // If the merge added records that weren't in remote, push back to Postgres now
      const remoteCount = (remote.feedback || []).length;
      if ((merged.feedback || []).length > remoteCount) {
        console.warn(`[CoE Tracker] Recovering ${merged.feedback.length - remoteCount} local-only record(s) — pushing to Postgres`);
        fetch(`${API_BASE}/api/data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged)
        }).catch(e => console.warn('[CoE Tracker] Recovery push failed:', e));
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      return merged;
    }
  } catch (e) {
    console.warn('[CoE Tracker] Remote load failed, using local cache:', e);
  }
  return local;
}

export async function saveData(data) {
  // Stamp with timestamp so we can compare freshness
  const stamped = { ...data, _savedAt: Date.now() };

  // Write locally immediately so the UI never stalls
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped));

  try {
    // Read current remote state, merge with what we're saving, then write back.
    // This means two users saving at the same time won't overwrite each other.
    let toSave = stamped;
    try {
      const res = await fetch(`${API_BASE}/api/data`);
      if (res.ok) {
        const remote = await res.json();
        if (remote && Array.isArray(remote.feedback)) {
          toSave = mergeData(remote, stamped);
          // Keep local in sync with merged version too
          localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
        }
      }
    } catch (e) {
      // If we can't fetch remote, just save what we have locally — still better than nothing
      console.warn('[CoE Tracker] Could not fetch remote before save, proceeding with local data:', e);
    }

    const saveRes = await fetch(`${API_BASE}/api/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toSave)
    });

    if (!saveRes.ok) throw new Error(`HTTP ${saveRes.status}`);

  } catch (e) {
    console.warn('[CoE Tracker] Remote save failed:', e);
    if (_onSaveError) _onSaveError();
  }
}

// AI dedup analysis cache — stored in its own Postgres table (not the shared app_data blob)
// so repeat visits can skip re-running the AI pipeline on unchanged feedback, and only the
// feedback that's new or edited since the last run needs to be (re)analyzed.
export async function loadDedupCache(initiativeId) {
  const res = await fetch(`${API_BASE}/api/dedup-cache?initiativeId=${encodeURIComponent(initiativeId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveDedupCache(initiativeId, payload) {
  const res = await fetch(`${API_BASE}/api/dedup-cache`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initiativeId, payload })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function formatDate(str) {
  if (!str) return '';
  const [year, month, day] = str.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
