import React, { useState, useEffect } from 'react';
import { loadData, saveData, onSaveError, cutoverIsWritable, effectiveClosedLoop } from './data';
import { getApiKey, setApiKey, clearApiKey } from './apiKey';
import InitiativesView from './components/InitiativesView';
import InitiativeDetail from './components/InitiativeDetail';
import FeedbackForm from './components/FeedbackForm';
import FeedbackTable from './components/FeedbackTable';
import ClosedLoopModal from './components/ClosedLoopModal';
import Dashboard from './components/Dashboard';
import * as fieldInputApi from './fieldInputApi';

const NAV = ['Initiatives', 'All Feedback', 'Dashboard'];

export default function App() {
  const [data, setData] = useState(null);
  const [nav, setNav] = useState('Initiatives');
  const [selectedInitiativeId, setSelectedInitiativeId] = useState(null);
  const [closedLoopId, setClosedLoopId] = useState(null);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const [operationError, setOperationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    onSaveError(() => setOperationError('Shared display settings could not be saved to the server. Your current screen is preserved.'));
    reloadData();
  }, []);

  async function reloadData() { setLoading(true); setData(await loadData()); setLoading(false); }

  useEffect(() => {
    if (data) saveData(data);
  }, [data]);

  function handleDataChange(updated) { setData(updated); }

  async function mutateFieldInput(operation, apply) {
    if (!cutoverIsWritable(data.cutoverState, process.env, data.canonicalLoadError)) throw new Error('Canonical data is unavailable or cutover maintenance is active');
    if (busy) throw new Error('Another Field Input operation is already in progress');
    setBusy(true); setOperationError('');
    try {
      const result = await operation();
      setData(current => apply(current, result));
      return result;
    } catch (error) {
      setOperationError(error.message || 'The Field Input operation failed. Your entered values were not cleared.');
      throw error;
    } finally { setBusy(false); }
  }

  const fieldMutations = {
    create: value => mutateFieldInput(() => fieldInputApi.createFieldInput(value), (current, row) => ({ ...current, feedback: [row, ...current.feedback] })),
    createBulk: values => mutateFieldInput(() => fieldInputApi.createFieldInputs(values), (current, result) => ({ ...current, feedback: [...result.items, ...current.feedback] })),
    update: value => mutateFieldInput(() => fieldInputApi.updateFieldInput(value.submissionId, {
      expectedVersion: value.version, providerName: value.providerName, providerRole: value.providerRole,
      region: value.region, date: value.date, originalText: value.originalText,
      format: value.format, frictionPoints: value.frictionPoints, toolsMentioned: value.toolsMentioned,
      workarounds: value.workarounds, dealImpact: value.dealImpact, quotes: value.quotes, notes: value.notes
    }), (current, row) => ({ ...current, feedback: current.feedback.map(item => item.id === row.id ? row : item) })),
    remove: value => mutateFieldInput(() => fieldInputApi.deleteFieldInput(value.submissionId, value.version), current => ({ ...current, feedback: current.feedback.filter(item => item.id !== value.id), closedLoop: Object.fromEntries(Object.entries(current.closedLoop).filter(([id]) => id !== value.id)) })),
    createAction: (value, text) => mutateFieldInput(() => fieldInputApi.createFieldAction(value.submissionId, text), (current, action) => ({ ...current, feedback: current.feedback.map(item => item.id === value.id ? { ...item, actionItems: [...(item.actionItems || []), action] } : item) })),
    updateAction: (value, item, patch) => mutateFieldInput(() => fieldInputApi.updateFieldAction(value.submissionId, item.id, { expectedVersion: item.version, ...patch }), (current, action) => ({ ...current, feedback: current.feedback.map(row => row.id === value.id ? { ...row, actionItems: (row.actionItems || []).map(existing => existing.id === action.id ? action : existing) } : row) })),
    deleteAction: (value, item) => mutateFieldInput(() => fieldInputApi.deleteFieldAction(value.submissionId, item.id, item.version), current => ({ ...current, feedback: current.feedback.map(row => row.id === value.id ? { ...row, actionItems: (row.actionItems || []).filter(existing => existing.id !== item.id) } : row) })),
    updateLoop: (value, patch) => mutateFieldInput(() => fieldInputApi.updateFieldLoop(value.submissionId, { expectedVersion: data.closedLoop[value.id]?.version || 0, ...patch }), (current, result) => ({ ...current, closedLoop: { ...current.closedLoop, [value.id]: result.closedLoop } })),
    upsertInitiative: async (value) => {
      if (!cutoverIsWritable(data.cutoverState, process.env, data.canonicalLoadError)) throw new Error('Canonical data is unavailable or cutover maintenance is active'); setBusy(true); setOperationError('');
      try { const saved = value.id ? await fieldInputApi.updateInitiative(value.id, { ...value, expectedVersion: value.version }) : await fieldInputApi.createInitiative(value);
        setData(current => ({ ...current, initiatives: value.id ? current.initiatives.map(item => item.id === saved.id ? saved : item) : [...current.initiatives, saved] })); return saved;
      } catch (error) { setOperationError(error.message || 'The initiative was not saved.'); throw error; } finally { setBusy(false); }
    }
  };
  const mutations = { ...fieldMutations, busy, readOnly: !cutoverIsWritable(data?.cutoverState, process.env, data?.canonicalLoadError) };

  function selectInitiative(id) {
    setSelectedInitiativeId(id);
    setNav('Initiatives');
  }

  if (!data) return (
    <div style={{ minHeight: '100vh', background: '#f4f6f9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#0176D3', fontSize: 16, fontWeight: 600 }}>Loading...</div>
    </div>
  );

  const canonicalUnavailable = Boolean(data.canonicalLoadError);
  const totalInputs = canonicalUnavailable ? '—' : data.feedback.length;
  const closedLoopMap = effectiveClosedLoop(data);
  const openLoops = canonicalUnavailable ? '—' : data.feedback.filter(f => !closedLoopMap[f.id]?.closed).length;
  const closedLoops = canonicalUnavailable ? '—' : data.feedback.filter(f => closedLoopMap[f.id]?.closed).length;

  return (
    <div style={{ minHeight: '100vh', background: '#f4f6f9' }}>
      {/* Header */}
      <div style={styles.headerBar}>
        <div style={styles.headerInner}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>CoE Initiative Feedback Tracker</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 1 }}>Global PS CoE · Intelligence & Synthesis</div>
          </div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
            <HeaderStat label="Initiatives" value={data.initiatives.length} />
            <HeaderStat label="Field Inputs" value={totalInputs} />
            <HeaderStat label="Open Loops" value={openLoops} warn={openLoops > 0} />
            <HeaderStat label="Closed Loops" value={closedLoops} />
            <button onClick={() => { setKeyInput(getApiKey()); setShowKeyModal(true); }}
              title={hasKey ? 'LLM Gateway key is set' : 'Set your LLM Gateway key'}
              style={{ background: hasKey ? 'rgba(255,255,255,0.15)' : 'rgba(251,191,36,0.25)', border: `1px solid ${hasKey ? 'rgba(255,255,255,0.3)' : '#fbbf24'}`, borderRadius: 8, padding: '6px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#fff', fontSize: 13, fontWeight: 600 }}>
              🔑 {hasKey ? 'Key set' : 'Set AI key'}
            </button>
          </div>
        </div>
      </div>

      {/* Nav */}
      <div style={styles.navBar}>
        {NAV.map(n => (
          <button key={n} onClick={() => { setNav(n); setSelectedInitiativeId(null); }}
            style={{ ...styles.navBtn, ...(nav === n && !selectedInitiativeId ? styles.navBtnActive : {}) }}>
            {n === 'Initiatives' && '🏁 '}
            {n === 'All Feedback' && '📋 '}
            {n === 'Dashboard' && '📊 '}
            {n === 'AI Synthesis' && '✨ '}
            {n}
          </button>
        ))}
      </div>

      {/* Save warning banner */}
      {data.cutoverState?.stage !== 'canonical_active' && (
        <div role="status" style={{ background: '#e0f2fe', borderBottom: '1px solid #7dd3fc', padding: '10px 24px', color: '#075985', fontWeight: 600 }}>Canonical cutover maintenance is active. Field Inputs and initiatives are read-only; Jira, Timeline, and Slack updates remain available.</div>
      )}
      {canonicalUnavailable && (
        <div role="alert" style={{ background: '#fee2e2', borderBottom: '1px solid #fca5a5', padding: '12px 24px', color: '#991b1b', fontWeight: 700 }}>Canonical Field Inputs and initiatives could not be loaded. Counts and mutation controls are unavailable until retry succeeds. {data.canonicalLoadError} <button onClick={reloadData} disabled={loading}>Retry</button></div>
      )}
      {operationError && (
        <div role="alert" style={{ background: '#fef3c7', borderBottom: '1px solid #fcd34d', padding: '10px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: '#92400e', fontWeight: 600 }}>
            ⚠️ {operationError}
          </span>
          <button aria-label="Dismiss error" onClick={() => setOperationError('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#92400e', fontSize: 16, fontWeight: 700 }}>✕</button>
        </div>
      )}

      {/* Content */}
      <div style={{ maxWidth: 1100, margin: '0 auto', paddingBottom: 40 }}>
        {nav === 'Initiatives' && !selectedInitiativeId && (
          <InitiativesView data={data} onDataChange={handleDataChange} onSelectInitiative={selectInitiative} fieldMutations={mutations} />
        )}
        {nav === 'Initiatives' && selectedInitiativeId && (
          <InitiativeDetail
            initiativeId={selectedInitiativeId}
            data={data}
            onDataChange={handleDataChange}
            onBack={() => setSelectedInitiativeId(null)}
            onEditClosedLoop={setClosedLoopId}
            fieldMutations={mutations}
          />
        )}
        {nav === 'All Feedback' && (
          <FeedbackTable data={data} onDataChange={handleDataChange} onEditClosedLoop={setClosedLoopId} fieldMutations={mutations} />
        )}
        {nav === 'Dashboard' && (
          <Dashboard data={data} onDataChange={handleDataChange} />
        )}
      </div>

      {/* Closed Loop Modal */}
      {closedLoopId && (
        <ClosedLoopModal
          feedbackId={closedLoopId}
          data={data}
          onDataChange={handleDataChange}
          onClose={() => setClosedLoopId(null)}
          fieldMutations={mutations}
        />
      )}

      {/* API Key Modal */}
      {showKeyModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 480, maxWidth: '95vw' }}>
            <h2 style={{ color: '#032D60', fontSize: 18, fontWeight: 700, marginBottom: 6 }}>LLM Gateway Key</h2>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16, lineHeight: 1.6 }}>
              Enter your personal Salesforce LLM Gateway Express key. It is stored only in your browser and never sent anywhere except the AI gateway.
            </p>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>API Key</label>
            <input
              type="password"
              style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '9px 12px', fontSize: 14, outline: 'none', marginBottom: 16 }}
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              placeholder="sk-..."
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
              <button onClick={() => { clearApiKey(); setHasKey(false); setShowKeyModal(false); }}
                style={{ fontSize: 13, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                Remove key
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setShowKeyModal(false)}
                  style={{ background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}>
                  Cancel
                </button>
                <button onClick={() => { setApiKey(keyInput); setHasKey(!!keyInput.trim()); setShowKeyModal(false); }}
                  style={{ background: '#0176D3', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
                  Save Key
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HeaderStat({ label, value, warn }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: warn ? '#fcd34d' : '#fff' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
    </div>
  );
}

const styles = {
  headerBar: { background: 'linear-gradient(135deg, #032D60 0%, #0176D3 100%)', padding: '14px 24px' },
  headerInner: { maxWidth: 1100, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  navBar: { background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '0 24px', display: 'flex', gap: 0, maxWidth: '100%', overflowX: 'auto' },
  navBtn: { padding: '14px 20px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#6b7280', borderBottom: '3px solid transparent', whiteSpace: 'nowrap' },
  navBtnActive: { color: '#0176D3', borderBottomColor: '#0176D3' }
};
