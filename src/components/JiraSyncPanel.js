import React, { useState } from 'react';

const API_BASE = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001';

// Minimal CSV parser that handles quoted fields containing commas/newlines (Jira's default
// CSV export quotes any field with a comma, and ticket summaries often have one) — a naive
// split(',') would silently corrupt those rows.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findCol(headers, candidates) {
  const lower = headers.map(h => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx !== -1) return idx;
  }
  return -1;
}

// Parses a Jira CSV export into { key, summary, status, sprint, description, updated }.
// Column names vary by export view — the SEPSP backlog export uses "Story ID/Name/Status/
// Description", while a standard Jira issue-navigator export uses "Issue key/Summary/Status" —
// so each field checks both naming conventions.
function parseJiraCSV(text) {
  const rows = parseCSV(text.trim());
  if (rows.length < 2) return { issues: [], error: 'No data rows found.' };
  const headers = rows[0];
  const keyIdx = findCol(headers, ['story id', 'issue key', 'key']);
  const summaryIdx = findCol(headers, ['story name', 'summary']);
  const statusIdx = findCol(headers, ['story status', 'status']);
  const sprintIdx = findCol(headers, ['sprint name', 'sprint']);
  const typeIdx = findCol(headers, ['issue type', 'type']);
  const descIdx = findCol(headers, ['story description', 'description']);
  const updatedIdx = findCol(headers, ['updated']);

  if (keyIdx === -1 || summaryIdx === -1 || statusIdx === -1) {
    return { issues: [], error: 'Could not find ID/Key, Name/Summary, and Status columns — is this a Jira CSV export?' };
  }

  const issues = rows.slice(1).map(r => ({
    key: (r[keyIdx] || '').trim(),
    summary: (r[summaryIdx] || '').trim(),
    status: (r[statusIdx] || '').trim(),
    sprint: sprintIdx !== -1 ? (r[sprintIdx] || '').trim() : '',
    issueType: typeIdx !== -1 ? (r[typeIdx] || '').trim() : '',
    description: descIdx !== -1 ? (r[descIdx] || '').trim() : '',
    updated: updatedIdx !== -1 ? (r[updatedIdx] || '').trim() : ''
  })).filter(i => i.key && i.summary);

  return { issues, error: issues.length === 0 ? 'Parsed the file but found no valid ticket rows.' : null };
}

// Buckets a live-synced issue the same way DeliveryBadges/jiraStatusBucket in
// FeedbackAnalysisPanel.js does, just for the sync-preview counts shown here before saving.
function liveBucket(issue) {
  if (issue.statusCategory === 'done') return 'done';
  if (issue.statusCategory === 'indeterminate') return 'in-progress';
  return issue.sprintState === 'active' ? 'in-progress' : 'planned';
}

export default function JiraSyncPanel({ data, onDataChange, onClose }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [showCsv, setShowCsv] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [syncPreview, setSyncPreview] = useState(null);

  const existing = data.jiraIssues || [];

  async function handleLiveSync() {
    setSyncing(true);
    setSyncError(null);
    setSyncPreview(null);
    try {
      const res = await fetch(`${API_BASE}/api/jira-sync`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Sync failed (HTTP ${res.status})`);
      setSyncPreview(json);
    } catch (e) {
      setSyncError(e.message);
    } finally {
      setSyncing(false);
    }
  }

  function handleSaveLiveSync() {
    onDataChange({ ...data, jiraIssues: syncPreview.issues, jiraSyncedAt: syncPreview.syncedAt });
    onClose();
  }

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setText(reader.result); setError(null); setPreview(null); };
    reader.readAsText(file);
  }

  function handleParse() {
    const { issues, error: err } = parseJiraCSV(text);
    if (err) { setError(err); setPreview(null); return; }
    setError(null);
    setPreview(issues);
  }

  function handleSave() {
    onDataChange({ ...data, jiraIssues: preview, jiraSyncedAt: new Date().toISOString() });
    onClose();
  }

  const syncCounts = syncPreview && syncPreview.issues.reduce((acc, i) => {
    acc.total++;
    acc[i.issueType === 'Epic' ? 'epics' : 'stories']++;
    acc[liveBucket(i)]++;
    return acc;
  }, { total: 0, stories: 0, epics: 0, done: 0, 'in-progress': 0, planned: 0 });

  return (
    <div style={styles.overlay}>
      <div style={styles.box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ color: '#032D60', fontSize: 18, fontWeight: 700 }}>Connect Jira</h2>
          <button onClick={onClose} style={styles.ghostBtn}>✕</button>
        </div>

        <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6, marginBottom: 8 }}>
          Pulls every Story and Epic from the Jira project directly — past sprints (done), the active sprint (in progress), and future/unscheduled sprints (planned) — so each feedback point can show whether the team is already working on it or plans to.
        </p>

        {existing.length > 0 && (
          <div style={styles.currentBox}>
            Currently synced: <strong>{existing.length}</strong> tickets
            {data.jiraSyncedAt && <span> · last synced {new Date(data.jiraSyncedAt).toLocaleString()}</span>}
          </div>
        )}

        <button onClick={handleLiveSync} disabled={syncing} style={{ ...styles.primaryBtn, width: '100%', opacity: syncing ? 0.7 : 1 }}>
          {syncing ? '⏳ Pulling stories from Jira…' : '🔄 Sync Live from Jira'}
        </button>

        {syncError && (
          <div style={styles.errorBox}>
            {syncError}
            {syncError.includes('not configured') && (
              <div style={{ marginTop: 4 }}>Add JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN and JIRA_PROJECT_KEY to .env.local on the server.</div>
            )}
          </div>
        )}

        {syncPreview && !syncError && (
          <div style={styles.previewBox}>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#0369a1', marginBottom: 6 }}>
              Pulled {syncCounts.total} ticket{syncCounts.total !== 1 ? 's' : ''} ({syncCounts.stories} stories, {syncCounts.epics} epics) — looks good?
            </div>
            <div style={{ fontSize: 12, color: '#374151', display: 'flex', gap: 12, marginBottom: 8 }}>
              <span style={{ color: '#059669' }}>✓ {syncCounts.done} done</span>
              <span style={{ color: '#0369a1' }}>🔧 {syncCounts['in-progress']} in progress</span>
              <span style={{ color: '#6b7280' }}>📋 {syncCounts.planned} planned</span>
            </div>
            <div style={{ maxHeight: 160, overflowY: 'auto' }}>
              {syncPreview.issues.slice(0, 8).map(i => (
                <div key={i.key} style={{ fontSize: 12, color: '#374151', padding: '3px 0', borderBottom: '1px solid #e0f2fe' }}>
                  <strong>{i.key}</strong> · {i.status}{i.sprint ? ` · ${i.sprint}` : ''} — {i.summary.slice(0, 80)}{i.summary.length > 80 ? '…' : ''}
                </div>
              ))}
              {syncPreview.issues.length > 8 && <div style={{ fontSize: 12, color: '#6b7280', paddingTop: 4 }}>…and {syncPreview.issues.length - 8} more</div>}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={styles.ghostBtn}>Cancel</button>
          {syncPreview && !syncError && (
            <button onClick={handleSaveLiveSync} style={styles.primaryBtn}>Save {syncCounts.total} tickets</button>
          )}
        </div>

        <button onClick={() => setShowCsv(v => !v)} style={styles.linkBtn}>
          {showCsv ? '▲ Hide manual CSV import' : '▼ Or import manually via CSV export instead'}
        </button>

        {showCsv && (
          <div style={{ marginTop: 10, paddingTop: 12, borderTop: '1px solid #e5e7eb' }}>
            <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6, marginBottom: 8 }}>
              In Jira, open the backlog board → <strong>Export → CSV</strong>, then paste the file contents below (or upload the file).
            </p>

            <input type="file" accept=".csv,text/csv" onChange={handleFile} style={{ marginBottom: 10, fontSize: 13 }} />

            <textarea
              style={styles.textarea}
              value={text}
              onChange={e => { setText(e.target.value); setPreview(null); setError(null); }}
              placeholder={'Issue key,Summary,Issue Type,Status,...\nSEPSP-1234,Build sequencing - Data flows + Integrations,Story,In Progress,...'}
            />

            {error && <div style={styles.errorBox}>{error}</div>}

            {preview && !error && (
              <div style={styles.previewBox}>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#0369a1', marginBottom: 6 }}>
                  Parsed {preview.length} ticket{preview.length !== 1 ? 's' : ''} — looks good?
                </div>
                <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                  {preview.slice(0, 8).map(i => (
                    <div key={i.key} style={{ fontSize: 12, color: '#374151', padding: '3px 0', borderBottom: '1px solid #e0f2fe' }}>
                      <strong>{i.key}</strong> · {i.status}{i.sprint ? ` · ${i.sprint}` : ''} — {i.summary.slice(0, 80)}{i.summary.length > 80 ? '…' : ''}
                    </div>
                  ))}
                  {preview.length > 8 && <div style={{ fontSize: 12, color: '#6b7280', paddingTop: 4 }}>…and {preview.length - 8} more</div>}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              {!preview || error ? (
                <button onClick={handleParse} disabled={!text.trim()} style={{ ...styles.primaryBtn, opacity: text.trim() ? 1 : 0.5 }}>
                  Parse
                </button>
              ) : (
                <button onClick={handleSave} style={styles.primaryBtn}>Save {preview.length} tickets</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 },
  box: { background: '#fff', borderRadius: 12, padding: 24, width: 620, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' },
  textarea: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 10px', fontSize: 12, fontFamily: 'monospace', height: 130, resize: 'vertical', outline: 'none' },
  currentBox: { background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#0369a1', marginBottom: 10 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#b91c1c', marginTop: 10 },
  previewBox: { background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '10px 12px', marginTop: 10 },
  primaryBtn: { background: '#0176D3', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  ghostBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
  linkBtn: { background: 'transparent', color: '#0176D3', border: 'none', padding: '10px 0 0', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'block' }
};

export { parseJiraCSV };
