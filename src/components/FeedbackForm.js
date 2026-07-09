import React, { useState } from 'react';
import { REGIONS, generateId } from '../data';
import { callAI } from '../apiKey';
import ActionItems from './ActionItems';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';

pdfjsLib.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL}/pdf.worker.min.js`;

async function extractText(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = await Promise.all(
      Array.from({ length: pdf.numPages }, (_, i) =>
        pdf.getPage(i + 1).then(p => p.getTextContent()).then(tc => tc.items.map(i => i.str).join(' '))
      )
    );
    return pages.join('\n\n');
  }
  if (ext === 'docx' || ext === 'doc') {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    return workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name];
      return `[Sheet: ${name}]\n${XLSX.utils.sheet_to_csv(sheet)}`;
    }).join('\n\n');
  }
  return file.text();
}

const EMPTY_FORM = {
  date: new Date().toISOString().slice(0, 10),
  providerName: '',
  providerRole: '',
  region: '',
  format: '',
  initiativeId: '',
  frictionPoints: '',
  toolsMentioned: '',
  workarounds: '',
  dealImpact: '',
  quotes: '',
  notes: ''
};

const AI_EXTRACT_PROMPT = `You are helping a Salesforce Professional Services CoE Advisor log field feedback.
Your job is to split the content into DISCRETE, ACTIONABLE feedback records. Apply these rules:

1. If feedback from MULTIPLE PEOPLE is present, create one record per person.
2. If feedback from ONE PERSON covers MULTIPLE DISTINCT TOPICS (e.g. separate bullet points, numbered items, or clearly separate themes), create one record per topic — even if they're from the same person.
3. Only combine content into a single record if it is genuinely one cohesive thought about one topic.

Return ONLY a valid JSON array where each element is one feedback record:
[
  {
    "providerName": "name of the person if known, or empty string",
    "providerRole": "their role/title if known, or empty string",
    "region": "one of: Global, REG, LATAM, TMT/CBS, PACE, PubSec, APAC ANZ, APAC ASEAN, APAC Japan, EMEA UK, EMEA N & Cen, EMEA S & France — or empty string if unclear",
    "date": "date in YYYY-MM-DD format if found, or empty string",
    "notes": "the full content of this specific feedback item, preserving all detail and context."
  }
]
Return ONLY the JSON array. No explanation, no markdown, no code fences.

CONTENT:
`;

export default function FeedbackForm({ data, onDataChange, defaultInitiativeId, onClose, editEntry }) {
  const isEditing = !!editEntry;
  const [form, setForm] = useState(isEditing ? { ...EMPTY_FORM, ...editEntry } : { ...EMPTY_FORM, initiativeId: defaultInitiativeId || '' });
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [newAction, setNewAction] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  // Bulk import state
  const [bulkRecords, setBulkRecords] = useState(null);
  const [bulkInitiativeId, setBulkInitiativeId] = useState(defaultInitiativeId || '');
  const [bulkSaved, setBulkSaved] = useState(false);

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function processText(text, sourceName) {
    setUploading(true);
    setUploadStatus('Asking AI to extract feedback records...');
    setUploadError('');
    setBulkRecords(null);
    try {
      const raw = await callAI(AI_EXTRACT_PROMPT + text.slice(0, 12000));
      const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      const extracted = JSON.parse(clean);
      if (!Array.isArray(extracted) || extracted.length === 0) throw new Error('No records found');
      const today = new Date().toISOString().slice(0, 10);
      if (extracted.length === 1) {
        const rec = extracted[0];
        setForm(f => ({
          ...f,
          providerName: rec.providerName || f.providerName,
          providerRole: rec.providerRole || f.providerRole,
          region: rec.region || f.region,
          date: rec.date || f.date,
          notes: f.notes ? f.notes + '\n\n' + (rec.notes || '') : (rec.notes || f.notes)
        }));
        setUploadStatus(`✓ 1 record extracted from ${sourceName}. Review and adjust below.`);
      } else {
        setBulkRecords(extracted.map(rec => ({
          ...EMPTY_FORM,
          id: generateId(),
          providerName: rec.providerName || '',
          providerRole: rec.providerRole || '',
          region: rec.region || '',
          date: rec.date || today,
          notes: rec.notes || '',
          initiativeId: defaultInitiativeId || ''
        })));
        setBulkInitiativeId(defaultInitiativeId || '');
        setUploadStatus(`✓ ${extracted.length} feedback records found in ${sourceName}. Review below before saving.`);
      }
    } catch (err) {
      const hint = err.message === 'NO_KEY'
        ? 'Set your LLM Gateway key using the key icon at the top of the page.'
        : err.message.includes('JSON') || err.message.includes('records')
        ? 'AI response was incomplete — try a shorter document or less text.'
        : 'Check that your LLM Gateway key is valid.';
      setUploadError(`AI extraction failed — ${hint}`);
    }
    setUploading(false);
  }

  async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    setUploadStatus('Reading document...');
    let text = '';
    try {
      text = await extractText(file);
    } catch (err) {
      setUploadError(`Could not read file: ${err.message}`);
      return;
    }
    await processText(text, `"${file.name}"`);
  }

  async function handlePasteSubmit() {
    if (!pasteText.trim()) return;
    setShowPaste(false);
    await processText(pasteText, 'pasted text');
    setPasteText('');
  }

  function handleSave() {
    if (!form.providerName.trim()) return;
    let updated;
    if (isEditing) {
      updated = { ...data, feedback: data.feedback.map(f => f.id === editEntry.id ? { ...f, ...form } : f) };
    } else {
      const entry = { ...form, id: generateId(), createdAt: new Date().toISOString() };
      updated = { ...data, feedback: [entry, ...data.feedback] };
    }
    onDataChange(updated);
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      setForm({ ...EMPTY_FORM, initiativeId: defaultInitiativeId || '' });
      setUploadStatus('');
      setUploadError('');
      if (onClose) onClose();
    }, 1200);
  }

  function handleBulkSave() {
    const validRecords = bulkRecords.filter(r => r.providerName.trim());
    if (validRecords.length === 0) return;
    const entries = validRecords.map(r => ({
      ...r,
      initiativeId: bulkInitiativeId,
      id: r.id || generateId(),
      createdAt: new Date().toISOString()
    }));
    const updated = { ...data, feedback: [...entries, ...data.feedback] };
    onDataChange(updated);
    setBulkSaved(true);
    setTimeout(() => {
      setBulkSaved(false);
      setBulkRecords(null);
      setUploadStatus('');
      if (onClose) onClose();
    }, 1500);
  }

  function updateBulkRecord(id, field, value) {
    setBulkRecords(recs => recs.map(r => r.id === id ? { ...r, [field]: value } : r));
  }

  function removeBulkRecord(id) {
    setBulkRecords(recs => {
      const remaining = recs.filter(r => r.id !== id);
      return remaining.length === 0 ? null : remaining;
    });
  }

  const f = form;
  const validBulk = bulkRecords ? bulkRecords.filter(r => r.providerName.trim()).length : 0;

  return (
    <div style={styles.wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: '#032D60', fontSize: 20, fontWeight: 700 }}>{isEditing ? 'Edit Field Input' : 'New Field Input'}</h2>
        {onClose && <button onClick={onClose} style={styles.ghostBtn}>✕ Cancel</button>}
      </div>

      {/* Upload section */}
      {!isEditing && (
        <div style={styles.uploadBox}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 18 }}>📄</span>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#032D60' }}>Upload a Document</span>
            <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 4 }}>— AI extracts one or many feedback records automatically</span>
          </div>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>
            Upload a spreadsheet, meeting notes, transcript, Word doc, or PDF. If multiple people's feedback is present, each becomes a separate record.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ ...styles.uploadLabel, opacity: uploading ? 0.6 : 1 }}>
              {uploading ? '⏳ Extracting...' : '📎 Choose File'}
              <input type="file" accept=".txt,.md,.text,.csv,.pdf,.doc,.docx,.xls,.xlsx" onChange={handleFileUpload} style={{ display: 'none' }} disabled={uploading} />
            </label>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>PDF, Word, Excel, CSV, TXT</span>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>or</span>
            <button onClick={() => setShowPaste(v => !v)} disabled={uploading}
              style={{ ...styles.uploadLabel, background: '#fff', color: '#0176D3', border: '1px solid #0176D3', opacity: uploading ? 0.6 : 1 }}>
              📋 Paste Text
            </button>
          </div>
          {showPaste && (
            <div style={{ marginTop: 10 }}>
              <textarea
                style={{ ...styles.textarea, height: 120, marginBottom: 8 }}
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                placeholder="Paste meeting notes, a feedback summary, Slack messages, or any text containing feedback from one or more people..."
                autoFocus
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handlePasteSubmit} disabled={!pasteText.trim()}
                  style={{ ...styles.uploadLabel, opacity: !pasteText.trim() ? 0.6 : 1 }}>
                  Extract Feedback
                </button>
                <button onClick={() => { setShowPaste(false); setPasteText(''); }}
                  style={{ ...styles.ghostBtn, fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}
          {uploadStatus && <p style={{ fontSize: 13, color: '#059669', marginTop: 8 }}>{uploadStatus}</p>}
          {uploadError && <p style={{ fontSize: 13, color: '#dc2626', marginTop: 8 }}>{uploadError}</p>}
        </div>
      )}

      {/* ── BULK REVIEW MODE ── */}
      {bulkRecords && (
        <div>
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#032D60', marginBottom: 8 }}>
              {bulkRecords.length} records ready to import
              <span style={{ fontSize: 13, fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>— review and remove any you don't want to save</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Link all to initiative:</label>
              <select style={{ ...styles.input, marginBottom: 0, minWidth: 200 }} value={bulkInitiativeId} onChange={e => setBulkInitiativeId(e.target.value)}>
                <option value="">— Not linked —</option>
                {data.initiatives.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            {bulkRecords.map((rec, idx) => (
              <div key={rec.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, background: '#fafafa' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Record {idx + 1}</span>
                  <button onClick={() => removeBulkRecord(rec.id)} style={{ background: 'none', border: '1px solid #fecaca', borderRadius: 4, color: '#dc2626', fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}>Remove</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={styles.label}>Provider Name *</label>
                    <input style={{ ...styles.input, marginBottom: 0, borderColor: !rec.providerName.trim() ? '#fca5a5' : '#d1d5db' }}
                      value={rec.providerName} onChange={e => updateBulkRecord(rec.id, 'providerName', e.target.value)}
                      placeholder="Required" />
                  </div>
                  <div>
                    <label style={styles.label}>Role</label>
                    <input style={{ ...styles.input, marginBottom: 0 }} value={rec.providerRole}
                      onChange={e => updateBulkRecord(rec.id, 'providerRole', e.target.value)} placeholder="e.g. VP, AE..." />
                  </div>
                  <div>
                    <label style={styles.label}>Region</label>
                    <select style={{ ...styles.input, marginBottom: 0 }}
                      value={rec.region} onChange={e => updateBulkRecord(rec.id, 'region', e.target.value)}>
                      <option value="">— Select —</option>
                      {REGIONS.map(r => <option key={r}>{r}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={styles.label}>Date</label>
                    <input type="date" style={{ ...styles.input, marginBottom: 0 }} value={rec.date}
                      onChange={e => updateBulkRecord(rec.id, 'date', e.target.value)} />
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <label style={styles.label}>Notes</label>
                  <textarea style={{ ...styles.textarea, height: 80, marginBottom: 0 }} value={rec.notes}
                    onChange={e => updateBulkRecord(rec.id, 'notes', e.target.value)}
                    placeholder="Feedback notes..." />
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button onClick={() => { setBulkRecords(null); setUploadStatus(''); }} style={styles.ghostBtn}>
              ← Back to manual entry
            </button>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {validBulk < bulkRecords.length && (
                <span style={{ fontSize: 13, color: '#d97706' }}>{bulkRecords.length - validBulk} record{bulkRecords.length - validBulk > 1 ? 's' : ''} missing provider name</span>
              )}
              <button onClick={handleBulkSave} disabled={validBulk === 0} style={{ ...styles.primaryBtn, opacity: bulkSaved || validBulk === 0 ? 0.7 : 1 }}>
                {bulkSaved ? `✓ ${validBulk} records saved!` : `Save ${validBulk} Record${validBulk !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SINGLE ENTRY FORM ── */}
      {!bulkRecords && (
        <>
          <div style={styles.grid2}>
            <div>
              <label style={styles.label}>Date *</label>
              <input type="date" style={styles.input} value={f.date} onChange={e => set('date', e.target.value)} />
            </div>
            <div>
              <label style={styles.label}>Initiative</label>
              <select style={styles.input} value={f.initiativeId} onChange={e => set('initiativeId', e.target.value)}>
                <option value="">— Not linked —</option>
                {data.initiatives.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
          </div>

          <div style={styles.grid3}>
            <div>
              <label style={styles.label}>Feedback Provider *</label>
              <input style={styles.input} value={f.providerName} onChange={e => set('providerName', e.target.value)} placeholder="e.g. Jane Smith" />
            </div>
            <div>
              <label style={styles.label}>Role</label>
              <input style={styles.input} value={f.providerRole} onChange={e => set('providerRole', e.target.value)} placeholder="e.g. VP, Scoper, AE..." />
            </div>
            <div>
              <label style={styles.label}>Region *</label>
              <select style={styles.input} value={f.region} onChange={e => set('region', e.target.value)}>
                <option value="">— Select —</option>
                {REGIONS.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
          </div>

          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Intelligence Captured</h3>
            <textarea
              style={{ ...styles.textarea, height: 200 }}
              value={f.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Capture any relevant feedback: friction points, tools mentioned, workarounds, deal impact, direct quotes, or anything else worth noting..." />
          </div>

          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Action Items</h3>
            {(form.actionItems || []).map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6', opacity: a.done ? 0.5 : 1 }}>
                <input type="checkbox" checked={a.done}
                  onChange={() => set('actionItems', (form.actionItems || []).map(x => x.id === a.id ? { ...x, done: !x.done } : x))}
                  style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#0176D3', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13, textDecoration: a.done ? 'line-through' : 'none', color: '#1f2937' }}>{a.text}</span>
                <button onClick={() => set('actionItems', (form.actionItems || []).filter(x => x.id !== a.id))}
                  style={{ background: 'none', border: 'none', color: '#d1d5db', cursor: 'pointer', fontSize: 13, padding: 0 }}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input
                style={{ ...styles.input, marginBottom: 0 }}
                value={newAction}
                onChange={e => setNewAction(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!newAction.trim()) return;
                    set('actionItems', [...(form.actionItems || []), { id: generateId(), text: newAction.trim(), done: false, createdAt: new Date().toISOString() }]);
                    setNewAction('');
                  }
                }}
                placeholder="Add action item and press Enter..."
              />
              <button onClick={() => {
                if (!newAction.trim()) return;
                set('actionItems', [...(form.actionItems || []), { id: generateId(), text: newAction.trim(), done: false, createdAt: new Date().toISOString() }]);
                setNewAction('');
              }} style={{ background: '#0176D3', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                Add
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={handleSave} disabled={!form.providerName.trim()}
              style={{ ...styles.primaryBtn, opacity: saved || !form.providerName.trim() ? 0.7 : 1 }}>
              {saved ? '✓ Saved!' : isEditing ? 'Save Changes' : 'Save Field Input'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const styles = {
  wrap: { background: '#fff', borderRadius: 12, padding: 28, maxWidth: 780, margin: '0 auto' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 },
  section: { background: '#f8fafc', borderRadius: 8, padding: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: '#0176D3', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 8 },
  input: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 10px', fontSize: 14, marginBottom: 12, outline: 'none', background: '#fff' },
  textarea: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 10px', fontSize: 14, marginBottom: 12, outline: 'none', height: 80, resize: 'vertical', background: '#fff' },
  primaryBtn: { background: '#0176D3', color: '#fff', border: 'none', padding: '10px 24px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 15 },
  ghostBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
  uploadBox: { background: '#f0f9ff', border: '1px dashed #7dd3fc', borderRadius: 8, padding: 16, marginBottom: 20 },
  uploadLabel: { display: 'inline-block', background: '#0176D3', color: '#fff', padding: '7px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }
};
