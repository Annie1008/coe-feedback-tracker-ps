import React, { useState, useEffect } from 'react';
import { sendSlackDM } from '../data';
import { callFeedbackAI } from '../apiKey';

// Clicking to reach out always drafts a short, professional summary via AI first — the person
// reviews that exact draft before anything sends, whether by Slack or email. AI drafting is
// automatic on click, but the actual send (a Slack API call, or opening a mail draft) is always
// a separate, deliberate follow-up click; nothing fires on its own.
export default function SendToAdvisorButton({ advisorName, message, email }) {
  const [state, setState] = useState('idle'); // idle | drafting | ready | sending | sent | error | copied
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
      const hasContributors = /^By contributor:/m.test(message);
      // The weekly region/OU digest goes to the CoE advisor *about* their region, not about
      // feedback they personally submitted — the greeting/intro/closing need to say so explicitly,
      // by name and by region, instead of reading like a personal thank-you for their own input.
      const regionMatch = message.match(/^Weekly feedback summary — (.+)$/m);
      const isRegionDigest = !!regionMatch;
      const region = regionMatch ? regionMatch[1] : '';

      const breakdownInstruction = hasBreakdown
        ? `Present the fixed / being worked on / planned ahead / not yet addressed counts as short bullet points (one per line, "- Label: N"), using the exact numbers from the "Breakdown:" line below — don't recompute or estimate them.`
        : `Present the key counts (total points, how many people raised them) as short bullet points (one per line, "- Label: N"), using the exact numbers given below.`;
      const fixedDetailInstruction = hasFixedExamples
        ? ` After that, write 2-3 sentences naming what was actually fixed, drawing only on the items listed under "Already fixed, examples:" below — describe what each one was about, don't just restate the count.`
        : '';
      const contributorInstruction = hasContributors
        ? ` Then add a "By contributor:" section listing every contributor by name with their own status breakdown, copied exactly from the "By contributor:" lines below — don't invent, omit, or recompute anyone's numbers.`
        : '';
      const openingInstruction = isRegionDigest
        ? `1. A brief greeting to ${advisorName} by name, e.g. "Hi ${advisorName},".
2. One short intro sentence making clear this is the weekly feedback digest for the ${region} region — the OU/region ${advisorName} covers as its CoE advisor — so they can see what's landed for their region this week. Don't imply ${advisorName} personally submitted this feedback; it's from the people they support in ${region}.`
        : `1. A brief greeting line, e.g. "Hi ${advisorName},".
2. One short intro sentence on what this update covers.`;
      const closingInstruction = isRegionDigest
        ? `One short closing sentence thanking ${advisorName} for their support of the ${region} region and committing to keep them updated as the remaining items for their region progress — warm, not consultant-speak (avoid jargon like "visibility," "backlog drift," "sprint assignments").`
        : `One short closing sentence that thanks them for their input and commits to keeping them updated as the remaining items progress — warm and appreciative, not consultant-speak (avoid jargon like "visibility," "backlog drift," "sprint assignments").`;
      const text = await callFeedbackAI(
        `You are a business advisor writing a professional status update to ${advisorName}. Format it like a real Slack DM / email:
${openingInstruction}
3. ${breakdownInstruction}${fixedDetailInstruction}${contributorInstruction}
4. ${closingInstruction}
5. A brief sign-off line only (e.g. "Thanks,") — no name or title after it, the sender adds their own.
Keep every ticket key, number, and name exactly as given in the source below; don't invent or drop any of them.\n\n${message}`,
        850
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
      await sendSlackDM(email, draft);
      setState('sent');
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setErrorMsg(err.message);
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }

  function copy(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(draft || message);
    setState('copied');
    setTimeout(() => setState('idle'), 1500);
  }

  function mailtoHref() {
    const body = draft || message;
    const subject = body.split('\n')[0].slice(0, 200);
    return `mailto:${email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  if (state === 'idle') {
    return (
      <button onClick={startDraft} style={styles.btn} title={`Drafts a short, professional summary for ${advisorName} — you review it before anything sends`}>
        ✨ Draft update for {advisorName}
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
        {state === 'ready' && email && (
          <button onClick={confirmSend} style={styles.btnPrimary}>💬 Send via Slack</button>
        )}
        {state === 'ready' && (
          <a href={mailtoHref()} style={styles.emailBtn}>✉️ Open Email Draft</a>
        )}
        {state === 'ready' && !email && (
          <button onClick={copy} style={styles.btn}>{'📋 Copy for advisor'}</button>
        )}
        {state === 'ready' && <button onClick={startDraft} style={styles.regenBtn}>↻ Regenerate</button>}
        {state === 'ready' && <button onClick={() => setState('idle')} style={styles.cancelBtn}>Cancel</button>}
        {state === 'sending' && <span style={{ fontSize: 12, color: '#6b7280' }}>Sending…</span>}
        {state === 'sent' && <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>Sent ✓</span>}
        {state === 'error' && <span style={{ fontSize: 12, color: '#b91c1c' }}>Failed: {errorMsg}</span>}
        {state === 'copied' && <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>Copied ✓</span>}
      </span>
      {!email && state === 'ready' && (
        <span style={{ fontSize: 11, color: '#9ca3af' }}>No email on file yet for {advisorName} — copy the draft instead</span>
      )}
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
