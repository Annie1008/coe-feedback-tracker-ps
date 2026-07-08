import React, { useState } from 'react';
import { REGIONS, FEEDBACK_FORMATS, generateId } from '../data';
import { callAI } from '../apiKey';
import ActionItems from './ActionItems';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';

// Point pdf.js at its worker bundled with the package
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

  // Plain text fallback (.txt, .md, etc.)
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
Extract information from the document below and return ONLY a valid JSON object with these exact keys:
{
  "providerName": "name of the person who gave feedback, or empty string",
  "providerRole": "their role/title, or empty string",
  "region": "one of: REG, LATAM, TMT/CBS, PACE, PubSec, APAC ANZ, APAC ASEAN, APAC Japan, EMEA UK, EMEA N & Cen, EMEA S & France — or empty string if unclear",
  "format": "one of: Video Call, Phone Call, Slack, In-Person, Other — or empty string",
  "notes": "a comprehensive summary of all feedback including: friction points, tools mentioned, workarounds, deal impact, direct quotes, and any other relevant information. Write in clear paragraphs."
}
Return only the JSON object. No explanation, no markdown, no code fences.

DOCUMENT:
`;


export default function FeedbackForm({ data, onDataChange, defaultInitiativeId, onClose, editEntry }) {
  const isEditing = !!editEntry;
  const [form, setForm] = useState(isEditing ? { ...EMPTY_FORM, ...editEntry } : { ...EMPTY_FORM, initiativeId: defaultInitiativeId || '' });
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [newAction, setNewAction] = useState('');

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    setUploading(true);
    setUploadStatus('Reading document...');
    setUploadError('');

    let text = '';
    try {
      text = await extractText(file);
    } catch (err) {
      setUploading(false);
      setUploadError(`Could not read file: ${err.message}`);
      return;
    }

    setUploadStatus('Asking AI to extract feedback fields...');

    try {
      const raw = await callAI(AI_EXTRACT_PROMPT + text.slice(0, 8000));
      // Strip any accidental markdown fences
      const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      const extracted = JSON.parse(clean);

      setForm(f => {
        const merged = { ...f };
        for (const key of Object.keys(EMPTY_FORM)) {
          if (extracted[key] && !f[key]) merged[key] = extracted[key];
          else if (extracted[key] && f[key]) merged[key] = f[key]; // don't overwrite filled fields
        }
        // Always merge notes additively
        if (extracted.notes) {
          merged.notes = f.notes ? f.notes + '\n\n' + extracted.notes : extracted.notes;
        }
        return merged;
      });
      setUploadStatus(`✓ Fields populated from "${file.name}". Review and adjust as needed.`);
    } catch (err) {
      const hint = err.message === 'NO_KEY' ? 'Set your LLM Gateway key using the key icon at the top of the page.' : err.message.includes('JSON') ? 'AI response was incomplete — try a shorter document.' : 'Check that your LLM Gateway key is valid.';
      setUploadError(`AI extraction failed — ${hint}`);
    }

    setUploading(false);
  }

  function handleSave() {
    if (!form.providerName.trim() || !form.region) return;
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

  const f = form;
  return (
    <div style={styles.wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: '#032D60', fontSize: 20, fontWeight: 700 }}>{isEditing ? 'Edit Field Input' : 'New Field Input'}</h2>
        {onClose && <button onClick={onClose} style={styles.ghostBtn}>✕ Cancel</button>}
      </div>

      {/* Upload section — top of form */}
      <div style={styles.uploadBox}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 18 }}>📄</span>
          <span style={{ fontWeight: 700, fontSize: 14, color: '#032D60' }}>Upload a Document</span>
          <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 4 }}>— AI will parse it and populate the fields below</span>
        </div>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>
          Upload a Gemini notes export, meeting transcript, Word doc, PDF, or Excel file. Fields already filled in will not be overwritten.
        </p>
        <label style={{ ...styles.uploadLabel, opacity: uploading ? 0.6 : 1 }}>
          {uploading ? '⏳ Extracting...' : '📎 Choose File'}
          <input type="file" accept=".txt,.md,.text,.csv,.pdf,.doc,.docx,.xls,.xlsx" onChange={handleFileUpload} style={{ display: 'none' }} disabled={uploading} />
        </label>
        <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 10 }}>PDF, Word, Excel, CSV, TXT</span>
        {uploadStatus && <p style={{ fontSize: 13, color: '#059669', marginTop: 8 }}>{uploadStatus}</p>}
        {uploadError && <p style={{ fontSize: 13, color: '#dc2626', marginTop: 8 }}>{uploadError}</p>}
      </div>

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

      <div>
        <label style={styles.label}>Feedback Format</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {FEEDBACK_FORMATS.map(fmt => (
            <button key={fmt} onClick={() => set('format', f.format === fmt ? '' : fmt)}
              style={{ ...styles.chip, ...(f.format === fmt ? styles.chipActive : {}) }}>
              {fmt}
            </button>
          ))}
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
        <button onClick={handleSave} style={{ ...styles.primaryBtn, opacity: saved ? 0.7 : 1 }}>
          {saved ? '✓ Saved!' : isEditing ? 'Save Changes' : 'Save Field Input'}
        </button>
      </div>
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
  chip: { border: '1px solid #d1d5db', borderRadius: 20, padding: '5px 14px', fontSize: 13, cursor: 'pointer', background: '#fff', color: '#374151' },
  chipActive: { background: '#0176D3', color: '#fff', borderColor: '#0176D3' },
  primaryBtn: { background: '#0176D3', color: '#fff', border: 'none', padding: '10px 24px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 15 },
  ghostBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
  uploadBox: { background: '#f0f9ff', border: '1px dashed #7dd3fc', borderRadius: 8, padding: 16, marginBottom: 20 },
  uploadLabel: { display: 'inline-block', background: '#0176D3', color: '#fff', padding: '7px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }
};
