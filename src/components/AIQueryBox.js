import React, { useState } from 'react';
import { REGIONS } from '../data';
import { callAI } from '../apiKey';

function buildContext(data, initiativeId) {
  const initiatives = initiativeId
    ? data.initiatives.filter(i => i.id === initiativeId)
    : data.initiatives;
  const feedback = initiativeId
    ? data.feedback.filter(f => f.initiativeId === initiativeId)
    : data.feedback;

  const initSummaries = initiatives.map(i => {
    const fb = data.feedback.filter(f => f.initiativeId === i.id);
    const enabledOUs = REGIONS.filter(r => i.ouEnablement?.[r]?.enabled);
    return `Initiative: ${i.name}
Description: ${i.description || 'N/A'}
Rollout Date: ${i.rolloutDate || 'TBD'}
Enabled OUs: ${enabledOUs.length > 0 ? enabledOUs.join(', ') : 'None'}
Feedback count: ${fb.length}`;
  }).join('\n\n');

  const fbSummaries = feedback.map(f => {
    const init = data.initiatives.find(i => i.id === f.initiativeId);
    const parts = [];
    if (f.frictionPoints) parts.push(`Friction: ${f.frictionPoints}`);
    if (f.toolsMentioned) parts.push(`Tools: ${f.toolsMentioned}`);
    if (f.workarounds) parts.push(`Workarounds: ${f.workarounds}`);
    if (f.dealImpact) parts.push(`Deal impact: ${f.dealImpact}`);
    if (f.quotes) parts.push(`Quotes: ${f.quotes}`);
    if (f.notes) parts.push(f.notes);
    const actions = (f.actionItems || []).filter(a => !a.done).map(a => a.text);
    return `---
Provider: ${f.providerName}${f.providerRole ? ` (${f.providerRole})` : ''}
Region/OU: ${f.region}
Date: ${f.date}
Format: ${f.format || 'N/A'}
Initiative: ${init?.name || 'Unlinked'}
Loop closed: ${data.closedLoop[f.id]?.closed ? 'Yes' : 'No'}
${parts.join('\n')}${actions.length > 0 ? `\nOpen actions: ${actions.join('; ')}` : ''}`;
  }).join('\n');

  return `You are an AI assistant for a Salesforce Global Professional Services CoE (Center of Excellence) Advisor tool. Answer questions based ONLY on the data below. Be concise and specific. If the data doesn't contain enough to answer, say so clearly.

=== INITIATIVES ===
${initSummaries}

=== FIELD FEEDBACK (${feedback.length} entries) ===
${fbSummaries || 'No feedback logged yet.'}`;
}

const SUGGESTED = [
  'What are the most common friction points?',
  'Which OUs have the most open loops?',
  'What patterns do you see across regions?',
  'Summarize the key themes from all feedback',
];

export default function AIQueryBox({ data, initiativeId }) {
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);

  async function ask(q) {
    const question = (q || query).trim();
    if (!question) return;
    setLoading(true);
    setError('');
    setAnswer('');
    try {
      const context = buildContext(data, initiativeId);
      const prompt = `${context}\n\n=== QUESTION ===\n${question}`;
      const response = await callAI(prompt);
      setAnswer(response);
      setHistory(h => [{ q: question, a: response }, ...h].slice(0, 5));
      setQuery('');
    } catch (e) {
      setError(e.message === 'NO_KEY' ? 'Set your LLM Gateway key using the key icon at the top of the page.' : 'AI request failed — check that your LLM Gateway key is valid.');
    }
    setLoading(false);
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.icon}>✨</span>
        <div>
          <div style={styles.title}>Ask AI about {initiativeId ? 'this initiative' : 'all initiatives'}</div>
          <div style={styles.subtitle}>Ask anything about the feedback data — patterns, gaps, summaries, recommendations</div>
        </div>
      </div>

      {/* Suggested questions */}
      {!answer && !loading && history.length === 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {SUGGESTED.map(s => (
            <button key={s} onClick={() => ask(s)} style={styles.chip}>{s}</button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={styles.input}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !loading && ask()}
          placeholder="e.g. Which regions need attention? What are the top risks?"
          disabled={loading}
        />
        <button onClick={() => ask()} disabled={loading || !query.trim()} style={{ ...styles.askBtn, opacity: loading || !query.trim() ? 0.6 : 1 }}>
          {loading ? '...' : 'Ask'}
        </button>
      </div>

      {/* Error */}
      {error && <p style={{ fontSize: 13, color: '#dc2626', marginTop: 8 }}>{error}</p>}

      {/* Loading */}
      {loading && (
        <div style={styles.answerBox}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#0176D3', fontSize: 13 }}>
            <span style={{ animation: 'pulse 1s infinite' }}>⏳</span> Thinking...
          </div>
        </div>
      )}

      {/* Answer */}
      {answer && (
        <div style={styles.answerBox}>
          <p style={{ fontSize: 13, color: '#1f2937', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{answer}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={() => { setAnswer(''); setQuery(''); }} style={styles.ghostBtn}>Ask another</button>
            <button onClick={() => setHistory([])} style={{ ...styles.ghostBtn, fontSize: 11, color: '#9ca3af', borderColor: '#e5e7eb' }}>Clear history</button>
          </div>
        </div>
      )}

      {/* History */}
      {!answer && history.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Recent</div>
          {history.map((item, i) => (
            <div key={i} style={styles.historyItem}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#0176D3', marginBottom: 4 }}>Q: {item.q}</div>
              <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>{item.a.slice(0, 200)}{item.a.length > 200 ? '…' : ''}</div>
              <button onClick={() => setAnswer(item.a)} style={{ ...styles.ghostBtn, fontSize: 11, marginTop: 6, padding: '3px 10px' }}>View full answer</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { background: 'linear-gradient(135deg, #f0f7ff 0%, #f8fafc 100%)', border: '1px solid #bae6fd', borderRadius: 12, padding: 20, marginBottom: 24 },
  header: { display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 14 },
  icon: { fontSize: 22, lineHeight: 1, marginTop: 2 },
  title: { fontSize: 15, fontWeight: 700, color: '#032D60' },
  subtitle: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  chip: { background: '#fff', border: '1px solid #bae6fd', borderRadius: 20, padding: '5px 12px', fontSize: 12, color: '#0176D3', cursor: 'pointer', fontWeight: 500 },
  input: { flex: 1, border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 14px', fontSize: 14, outline: 'none', background: '#fff' },
  askBtn: { background: '#0176D3', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontWeight: 700, cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap' },
  answerBox: { background: '#fff', border: '1px solid #e0f0ff', borderRadius: 8, padding: 16, marginTop: 12 },
  ghostBtn: { background: 'transparent', color: '#374151', border: '1px solid #d1d5db', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  historyItem: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 8 },
};
