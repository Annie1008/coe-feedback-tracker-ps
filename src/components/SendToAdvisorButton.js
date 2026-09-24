import React, { useState } from 'react';
import { sendSlackDM } from '../data';

// Sending is always a deliberate two-click action (Send -> Confirm) — a stray click can never
// fire a DM on its own, and nothing here is ever triggered by a save or a timer. If we don't
// have this advisor's email on file yet (fill it in under Dashboard's "Advisor Contacts" card),
// falls back to copying the update to the clipboard instead of pretending we can message them.
export default function SendToAdvisorButton({ advisorName, message, email }) {
  const [state, setState] = useState('idle'); // idle | confirm | sending | sent | error
  const [errorMsg, setErrorMsg] = useState('');

  function copy(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(message);
    setState('copied');
    setTimeout(() => setState('idle'), 1500);
  }

  async function confirmSend(e) {
    e.stopPropagation();
    setState('sending');
    try {
      await sendSlackDM(email, message);
      setState('sent');
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setErrorMsg(err.message);
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }

  if (!email) {
    return (
      <button onClick={copy} style={styles.btn} title={`No Slack email on file yet for ${advisorName} — copies the update instead`}>
        {state === 'copied' ? 'Copied ✓' : '📋 Copy for advisor'}
      </button>
    );
  }

  if (state === 'confirm') {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>DM {advisorName} on Slack?</span>
        <button onClick={confirmSend} style={styles.btnPrimary}>Confirm</button>
        <button onClick={() => setState('idle')} style={styles.btn}>Cancel</button>
      </span>
    );
  }

  return (
    <button
      onClick={e => { e.stopPropagation(); setState('confirm'); }}
      disabled={state === 'sending'}
      style={styles.btn}>
      {state === 'sending' ? 'Sending…' : state === 'sent' ? 'Sent ✓' : state === 'error' ? `Failed: ${errorMsg}` : `💬 Send Slack DM to ${advisorName}`}
    </button>
  );
}

const styles = {
  btn: { fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#fff', whiteSpace: 'nowrap' },
  btnPrimary: { fontSize: 12, border: '1px solid #0176D3', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#0176D3', color: '#fff', whiteSpace: 'nowrap' }
};
