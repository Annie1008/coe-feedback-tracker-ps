export const REGIONS = [
  'REG', 'LATAM', 'TMT/CBS', 'PACE', 'PubSec',
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

const DEFAULT_DATA = { initiatives: DEFAULT_INITIATIVES.map(i => ({ ...i })), feedback: [], closedLoop: {} };

const API_BASE = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001';

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
  try {
    const res = await fetch(`${API_BASE}/api/data`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = await res.json();
    if (remote && Array.isArray(remote.initiatives) && remote.initiatives.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
      return remote;
    }
  } catch (e) {
    console.warn('[CoE Tracker] Remote load failed, using local cache:', e);
  }
  return loadLocalData();
}

export function saveData(data) {
  // Write to localStorage immediately so the UI never stalls
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

  // Fire-and-forget to Postgres via the server proxy
  fetch(`${API_BASE}/api/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).catch(e => console.warn('[CoE Tracker] Remote save failed:', e));
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function formatDate(str) {
  if (!str) return '';
  const [year, month, day] = str.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
