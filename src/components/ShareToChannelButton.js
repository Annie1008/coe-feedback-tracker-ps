import React, { useState } from 'react';
import { STATUS_SHARE_CHANNEL, sendSlackChannelMessage } from '../data';

// Broader-audience status sharing — posts to a shared channel instead of DMing one advisor, so
// the whole team watching that channel sees it. Same deliberate two-click confirm as the DM
// button: nothing posts until a person explicitly confirms.
export default function ShareToChannelButton({ message, channel = STATUS_SHARE_CHANNEL }) {
  const [state, setState] = useState('idle'); // idle | confirm | sending | sent | error
  const [errorMsg, setErrorMsg] = useState('');

  async function confirmSend(e) {
    e.stopPropagation();
    setState('sending');
    try {
      await sendSlackChannelMessage(message, channel);
      setState('sent');
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setErrorMsg(err.message);
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }

  if (state === 'confirm') {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>Post to #{channel}?</span>
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
      {state === 'sending' ? 'Sending…' : state === 'sent' ? 'Posted ✓' : state === 'error' ? `Failed: ${errorMsg}` : `💬 Share to #${channel}`}
    </button>
  );
}

const styles = {
  btn: { fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#fff', whiteSpace: 'nowrap' },
  btnPrimary: { fontSize: 12, border: '1px solid #0176D3', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#0176D3', color: '#fff', whiteSpace: 'nowrap' }
};
