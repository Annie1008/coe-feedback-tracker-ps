import React, { useState, useEffect } from 'react';
import { loadData, saveData, onSaveError } from './data';
import { getApiKey, setApiKey, clearApiKey } from './apiKey';
import InitiativesView from './components/InitiativesView';
import InitiativeDetail from './components/InitiativeDetail';
import FeedbackForm from './components/FeedbackForm';
import FeedbackTable from './components/FeedbackTable';
import ClosedLoopModal from './components/ClosedLoopModal';
import Dashboard from './components/Dashboard';

const NAV = ['Initiatives', 'All Feedback', 'Dashboard'];

export default function App() {
  const [data, setData] = useState(null);
  const [nav, setNav] = useState('Initiatives');
  const [selectedInitiativeId, setSelectedInitiativeId] = useState(null);
  const [closedLoopId, setClosedLoopId] = useState(null);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const [saveWarning, setSaveWarning] = useState(false);

  useEffect(() => {
    onSaveError(() => setSaveWarning(true));
    loadData().then(setData);
  }, []);

  useEffect(() => {
    if (data) saveData(data);
  }, [data]);

  function handleDataChange(updated) { setData(updated); }

  function selectInitiative(id) {
    setSelectedInitiativeId(id);
    setNav('Initiatives');
  }

  if (!data) return (
    <div style={{ minHeight: '100vh', background: '#f4f6f9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#0176D3', fontSize: 16, fontWeight: 600 }}>Loading...</div>
    </div>
  );

  const totalInputs = data.feedback.length;
  const openLoops = data.feedback.filter(f => !data.closedLoop[f.id]?.closed).length;

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
      {saveWarning && (
        <div style={{ background: '#fef3c7', borderBottom: '1px solid #fcd34d', padding: '10px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: '#92400e', fontWeight: 600 }}>
            ⚠️ Your changes were saved locally but could not sync to the server. They will sync automatically next time the connection is available.
          </span>
          <button onClick={() => setSaveWarning(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#92400e', fontSize: 16, fontWeight: 700 }}>✕</button>
        </div>
      )}

      {/* Content */}
      <div style={{ maxWidth: 1100, margin: '0 auto', paddingBottom: 40 }}>
        {nav === 'Initiatives' && !selectedInitiativeId && (
          <InitiativesView data={data} onDataChange={handleDataChange} onSelectInitiative={selectInitiative} />
        )}
        {nav === 'Initiatives' && selectedInitiativeId && (
          <InitiativeDetail
            initiativeId={selectedInitiativeId}
            data={data}
            onDataChange={handleDataChange}
            onBack={() => setSelectedInitiativeId(null)}
            onEditClosedLoop={setClosedLoopId}
          />
        )}
        {nav === 'All Feedback' && (
          <FeedbackTable data={data} onDataChange={handleDataChange} onEditClosedLoop={setClosedLoopId} />
        )}
        {nav === 'Dashboard' && (
          <Dashboard data={data} />
        )}
      </div>

      {/* Closed Loop Modal */}
      {closedLoopId && (
        <ClosedLoopModal
          feedbackId={closedLoopId}
          data={data}
          onDataChange={handleDataChange}
          onClose={() => setClosedLoopId(null)}
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
