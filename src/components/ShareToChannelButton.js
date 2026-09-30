import React, { useState, useEffect } from 'react';
import { STATUS_SHARE_CHANNEL, sendSlackChannelMessage } from '../data';
import { callFeedbackAI } from '../apiKey';

// Same drafting flow as SendToAdvisorButton: clicking drafts a short, professional summary via
// AI automatically, the person reviews it, then picks how to actually send it — nothing posts or
// opens on its own. Email here opens a blank-recipient draft since a channel isn't one mailbox;
// the human adds whoever they want in their own mail client.
export default function ShareToChannelButton({ message, channel = STATUS_SHARE_CHANNEL }) {
  const [state, setState] = useState('idle'); // idle | drafting | ready | sending | sent | error
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => { setState('idle'); setDraft(''); setDraftError(''); }, [message]);

  async function startDraft(e) {
    e.stopPropagation();
    setState('drafting');
    setDraftError('');
    try {
      const hasBreakdown = /^Breakdown:/m.test(message);
      const hasFixedExamples = /^Already fixed, examples:/m.test(message);
      const breakdownInstruction = hasBreakdown
        ? `Present the fixed / being worked on / planned ahead / not yet addressed counts as short bullet points (one per line, "- Label: N"), using the exact numbers from the "Breakdown:" line below — don't recompute or estimate them.`
        : `Present the key counts (total points, how many people raised them) as short bullet points (one per line, "- Label: N"), using the exact numbers given below.`;
      const fixedDetailInstruction = hasFixedExamples
        ? ` After that, write 2-3 sentences naming what was actually fixed, drawing only on the items listed under "Already fixed, examples:" below — describe what each one was about, don't just restate the count.`
        : '';
      const text = await callFeedbackAI(
        `You are a business advisor writing a professional status update to the team. Format it like a real Slack post / email:
1. A brief greeting line, e.g. "Hi team,".
2. One short intro sentence on what this update covers.
3. ${breakdownInstruction}${fixedDetailInstruction}
4. One short closing sentence that thanks the team for their input and commits to keeping them updated as the remaining items progress — warm and appreciative, not consultant-speak (avoid jargon like "visibility," "backlog drift," "sprint assignments").
5. A brief sign-off line only (e.g. "Thanks,") — no name or title after it, the sender adds their own.
Keep every ticket key, number, and name exactly as given in the source below; don't invent or drop any of them.\n\n${message}`,
        650
      );
      const clean = text.trim();
      setDraft(clean || message);
      if (!clean) setDraftError('AI summary came back empty — showing the full digest instead.');
    } catch (err) {
      setDraft(message);
      setDraftError('AI summary failed — showing the full digest instead.');
    } finally {
      setState('ready');
    }
  }

  async function confirmSend(e) {
    e.stopPropagation();
    setState('sending');
    try {
      await sendSlackChannelMessage(draft, channel);
      setState('sent');
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setErrorMsg(err.message);
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }

  function mailtoHref() {
    const body = draft || message;
    const subject = body.split('\n')[0].slice(0, 200);
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  if (state === 'idle') {
    return (
      <button onClick={startDraft} style={styles.btn} title="Drafts a short, professional summary — you review it before anything posts or opens">
        ✨ Draft update for #{channel}
      </button>
    );
  }

  if (state === 'drafting') {
    return <span style={{ fontSize: 12, color: '#6b7280' }}>✨ Drafting a professional summary…</span>;
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }} onClick={e => e.stopPropagation()}>
      <div style={styles.preview}>
        <div style={{ whiteSpace: 'pre-wrap' }}>{draft}</div>
      </div>
      {draftError && <span style={{ fontSize: 11, color: '#b91c1c' }}>{draftError}</span>}
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {state === 'ready' && <button onClick={confirmSend} style={styles.btnPrimary}>💬 Post to #{channel}</button>}
        {state === 'ready' && <a href={mailtoHref()} style={styles.emailBtn}>✉️ Open Email Draft</a>}
        {state === 'ready' && <button onClick={startDraft} style={styles.regenBtn}>↻ Regenerate</button>}
        {state === 'ready' && <button onClick={() => setState('idle')} style={styles.cancelBtn}>Cancel</button>}
        {state === 'sending' && <span style={{ fontSize: 12, color: '#6b7280' }}>Sending…</span>}
        {state === 'sent' && <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>Posted ✓</span>}
        {state === 'error' && <span style={{ fontSize: 12, color: '#b91c1c' }}>Failed: {errorMsg}</span>}
      </span>
    </span>
  );
}

const styles = {
  btn: { fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#fff', whiteSpace: 'nowrap' },
  btnPrimary: { fontSize: 12, border: '1px solid #0176D3', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#0176D3', color: '#fff', whiteSpace: 'nowrap' },
  emailBtn: { fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', background: '#fff', whiteSpace: 'nowrap', color: '#374151', textDecoration: 'none', display: 'inline-block' },
  regenBtn: { fontSize: 11, color: '#6d28d9', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 },
  cancelBtn: { fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 },
  preview: { fontSize: 12.5, color: '#374151', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, padding: '8px 10px', maxWidth: 380, lineHeight: 1.4 }
};
