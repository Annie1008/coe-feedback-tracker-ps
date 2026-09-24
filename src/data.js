export const REGIONS = [
  'Global', 'REG', 'LATAM', 'TMT/CBS', 'PACE', 'PubSec',
  'APAC ANZ', 'APAC ASEAN', 'APAC Japan',
  'EMEA UK', 'EMEA N & Cen', 'EMEA S & France'
];

// Region -> CoE Advisor(s) who own that region, from the "Initiative Field Volunteers" roster.
// EMEA N & Cen and EMEA S & France each combine two source sub-regions with different advisors,
// so both names are kept rather than picking one arbitrarily. Global and APAC Japan have no
// advisor in the source roster yet (APAC Japan is listed there as "TBD").
export const ADVISOR_BY_REGION = {
  'Global': [],
  'REG': ['Sheetal Shah'],
  'LATAM': ['Daniela Valverde'],
  'TMT/CBS': ['Paul Giancola'],
  'PACE': ['Matt Dodyk'],
  'PubSec': ['Megan Madden'],
  'APAC ANZ': ['Adam McMahon'],
  'APAC ASEAN': ['Veneet Vishal'],
  'APAC Japan': [],
  'EMEA UK': ['Cyrill Lampart'],
  'EMEA N & Cen': ['Cyrill Lampart', 'Georg Hörning'],
  'EMEA S & France': ['Cyrill Lampart', 'Georg Hörning']
};

export function advisorsForRegion(region) {
  return ADVISOR_BY_REGION[region] || [];
}

// Seed values for the "Advisor Contacts" card, supplied directly by the user — kept as a
// fallback (not the source of truth) so anyone can still override an address in-app without a
// code change; whatever's saved in data.advisorEmails always wins over this.
export const DEFAULT_ADVISOR_EMAILS = {
  'Adam McMahon': 'amcmahon@salesforce.com',
  'Cyrill Lampart': 'clampart@salesforce.com',
  'Daniela Valverde': 'ddeleon@salesforce.com',
  'Georg Hörning': 'ghoerning@salesforce.com',
  'Matt Dodyk': 'mdodyk@salesforce.com',
  'Megan Madden': 'megan.madden@salesforce.com',
  'Paul Giancola': 'paul.giancola@salesforce.com',
  'Sheetal Shah': 'sheetal.shah@salesforce.com',
  'Veneet Vishal': 'vvishal@salesforce.com'
};

// Slack email for each advisor, used to DM them directly — Slack DMs are sent by looking up
// the recipient by email (server-side), not by a raw Slack member ID, since that's the only
// identifier we have any hope of getting reliably. data.advisorEmails (persisted, currently only
// settable by editing DEFAULT_ADVISOR_EMAILS above — there's no settings UI for it) always takes
// priority over the seed. advisorEmail() returning null just means the UI falls back to a
// copy-to-clipboard action instead of showing a "Send Slack DM" button.
export function advisorEmail(name, advisorEmails) {
  return (advisorEmails && advisorEmails[name]) || DEFAULT_ADVISOR_EMAILS[name] || null;
}

// Every advisor name that appears anywhere in the roster, deduped — used to render one input
// per advisor in the "Advisor Contacts" settings card regardless of how many regions they cover.
export function allAdvisorNames() {
  return Array.from(new Set(Object.values(ADVISOR_BY_REGION).flat())).sort();
}

// Same lookup, but for the person who actually submitted the feedback — lets a status update
// on all of their feedback go to them directly, not just their OU/CoE advisor. Kept as its own
// map (data.providerEmails), not a new field on the feedback record itself, since a teammate is
// mid-migration on the feedback record shape — see [[pending_feedback_restructure_hold]]. No seed
// values here (unlike advisors, we don't have these on hand); returns null until someone has a
// reason to add one, which just means the UI falls back to copy-to-clipboard for that person.
export function providerEmail(name, providerEmails) {
  return (providerEmails && providerEmails[name]) || null;
}

// Broad-audience status updates go to this shared channel instead of individual DMs, per the
// user's explicit direction — reaches everyone watching it, not just the one region's advisor.
export const STATUS_SHARE_CHANNEL = 'fy27-coe-collab';

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

const DEFAULT_DATA = { initiatives: DEFAULT_INITIATIVES.map(i => ({ ...i })), feedback: [], closedLoop: {}, podNotes: {}, podAssignments: {}, jiraIssues: [], jiraSyncedAt: null, timelineOverrides: {}, timelineSuggestions: {}, timelineHistory: [], timelineNotes: {}, dumpedGroups: {}, fixedGroups: {}, manualJiraLinks: {}, advisorEmails: {}, providerEmails: {} };

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
    fixedGroups: { ...(base.fixedGroups || {}), ...(incoming.fixedGroups || {}) },
    manualJiraLinks: { ...(base.manualJiraLinks || {}), ...(incoming.manualJiraLinks || {}) },
    // Advisor Slack emails — merged per-key like closedLoop/podNotes, so one person filling in
    // an email for advisor X can never wipe out another person's edit for advisor Y.
    advisorEmails: { ...(base.advisorEmails || {}), ...(incoming.advisorEmails || {}) },
    providerEmails: { ...(base.providerEmails || {}), ...(incoming.providerEmails || {}) },
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

// Both Slack sends below are only ever called from an explicit, human-clicked "Send"/"Confirm"
// action in the UI — never on a timer or on save — so a status change or closed-loop edit can
// never trigger a message on its own. Token lives server-side (server.js), never in the browser.
export async function sendSlackDM(email, message) {
  const res = await fetch(`${API_BASE}/api/slack/notify-advisor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, message })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export async function sendSlackChannelMessage(message, channel = STATUS_SHARE_CHANNEL) {
  const res = await fetch(`${API_BASE}/api/slack/notify-channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, message })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function formatDate(str) {
  if (!str) return '';
  const [year, month, day] = str.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// "YYYY-MM" key for grouping/filtering feedback by the month it was received (derived from the
// existing per-item `date` field — no separate month is stored, so this can never drift out of
// sync with the date itself).
export function monthKey(str) {
  if (!str) return '';
  return str.slice(0, 7);
}

export function monthLabel(str) {
  if (!str) return '';
  const [year, month] = str.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
