import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { SYNTHESIS_PROMPTS } from '../data';
import { callAI } from '../apiKey';

export default function SynthesisPanel({ data, initiativeId }) {
  const [selected, setSelected] = useState(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const scopedFeedback = initiativeId
    ? data.feedback.filter(f => f.initiativeId === initiativeId)
    : data.feedback;

  const initiative = initiativeId ? data.initiatives.find(i => i.id === initiativeId) : null;

  function buildContext() {
    return scopedFeedback.map((f, idx) => {
      const parts = [];
      if (f.frictionPoints) parts.push(`Friction Points: ${f.frictionPoints}`);
      if (f.toolsMentioned) parts.push(`Tools Mentioned: ${f.toolsMentioned}`);
      if (f.workarounds) parts.push(`Workarounds: ${f.workarounds}`);
      if (f.dealImpact) parts.push(`Deal Impact: ${f.dealImpact}`);
      if (f.quotes) parts.push(`Quotes: ${f.quotes}`);
      if (f.notes) parts.push(`Notes: ${f.notes}`);
      return `[Input ${idx + 1}] Date: ${f.date} | Provider: ${f.providerName}${f.providerRole ? ` (${f.providerRole})` : ''} | Region: ${f.region} | Format: ${f.format || 'N/A'}
${parts.join('\n') || 'No details captured.'}`;
    }).join('\n\n---\n\n');
  }

  async function handleRun() {
    if (!selected) return;
    if (scopedFeedback.length === 0) {
      setOutput('No field input data available. Add some feedback entries first.');
      return;
    }

    const promptTemplate = selected === 'custom'
      ? customPrompt
      : SYNTHESIS_PROMPTS.find(p => p.key === selected)?.description;

    const scope = initiative ? initiative.name : 'All Initiatives';
    const context = buildContext();
    const fullPrompt = `You are an AI analyst for a Salesforce Professional Services CoE. Analyze the field feedback data below and respond to the following task.

SCOPE: ${scope} (${scopedFeedback.length} field inputs)

TASK: ${promptTemplate}

FIELD INPUT DATA:
${context}

Respond in clear, structured prose. Use headers and bullet points where helpful. Be specific and actionable.`;

    setRunning(true);
    setOutput('');
    setError('');

    try {
      const result = await callAI(fullPrompt);
      setOutput(result);
    } catch (e) {
      setError(e.message === 'NO_KEY'
        ? 'Set your LLM Gateway key using the key icon at the top of the page.'
        : 'AI request failed — check that your LLM Gateway key is valid.');
    }
    setRunning(false);
  }

  return (
    <div style={styles.wrap}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 17, fontWeight: 700, color: '#032D60' }}>
          AI Synthesis
          {initiative && <span style={{ fontSize: 13, fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>— {initiative.name}</span>}
        </h3>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
          {scopedFeedback.length} input{scopedFeedback.length !== 1 ? 's' : ''} in scope
          {!initiativeId && ' across all initiatives'}
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 16 }}>
        {SYNTHESIS_PROMPTS.map(p => (
          <div key={p.key} onClick={() => setSelected(p.key)}
            style={{ ...styles.promptCard, ...(selected === p.key ? styles.promptCardActive : {}) }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{p.label}</div>
            <div style={{ fontSize: 12, color: selected === p.key ? 'rgba(255,255,255,0.8)' : '#6b7280' }}>{p.description}</div>
          </div>
        ))}
      </div>

      {selected === 'custom' && (
        <textarea style={styles.textarea} value={customPrompt} onChange={e => setCustomPrompt(e.target.value)}
          placeholder="Write your custom prompt here. All field input data will be included automatically." />
      )}

      <button onClick={handleRun} disabled={!selected || running}
        style={{ ...styles.primaryBtn, opacity: (!selected || running) ? 0.6 : 1 }}>
        {running ? '⏳ Running...' : 'Run Synthesis'}
      </button>

      {error && <p style={{ fontSize: 13, color: '#dc2626', marginTop: 10 }}>{error}</p>}

      {output && (
        <div style={styles.output}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#0176D3', textTransform: 'uppercase' }}>Output</span>
            <button onClick={() => setOutput('')} style={{ fontSize: 12, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
          </div>
          <div style={styles.markdown} className="markdown-output">
            <ReactMarkdown>{output}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { background: '#fff', borderRadius: 12, padding: 24 },
  promptCard: { border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, cursor: 'pointer', transition: 'all 0.15s', background: '#fafafa' },
  promptCardActive: { background: '#0176D3', color: '#fff', borderColor: '#0176D3' },
  textarea: { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '10px 12px', fontSize: 14, height: 100, resize: 'vertical', outline: 'none', marginBottom: 12 },
  primaryBtn: { background: '#0176D3', color: '#fff', border: 'none', padding: '10px 28px', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 15, marginBottom: 16 },
  output: { background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginTop: 4 },
  markdown: { fontSize: 14, color: '#1f2937', lineHeight: 1.7 }
};
