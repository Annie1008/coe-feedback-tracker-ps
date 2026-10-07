import React, { useState, useEffect } from 'react';
import { sendSlackDM } from '../data';
import { callFeedbackAI } from '../apiKey';

const CARE_ORDER = ['done', 'in-progress', 'planned', 'not-addressed'];
const CARE_META = {
  done: { icon: '✅', label: 'Already Fixed', bg: '#e6f4ea' },
  'in-progress': { icon: '⚙️', label: 'Being Worked On', bg: '#e8f0fe' },
  planned: { icon: '📅', label: 'Planned Ahead', bg: '#fdf3d9' },
  'not-addressed': { icon: '⏰', label: 'Not Yet Addressed', bg: '#fbe9e7' }
};

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// FeedbackByPerson.js appends a ⟦Priority: …· Fix Version: …⟧ tag to example bullet lines —
// pulled straight from the live Jira sync. Split it back out here so the clean item text goes
// to the AI (it shouldn't be asked to write a sentence about "Priority: High") while the tag
// itself still reaches the DM as structured Priority/Fix Version data.
const TAG_RE = /\s*⟦([^⟧]*)⟧\s*$/;
function parseExampleLine(raw) {
  const m = raw.match(TAG_RE);
  if (!m) return { summary: raw, priority: '', fixVersion: '' };
  const tagBody = m[1];
  const summary = raw.slice(0, m.index).trim();
  const priority = (tagBody.match(/Priority:\s*([^·]+)/) || [])[1]?.trim() || '';
  const fixVersion = (tagBody.match(/Fix Version:\s*([^·]+)/) || [])[1]?.trim() || '';
  return { summary, priority, fixVersion };
}

// Jira's Fix versions names on this project are "YYYY-MM-DD <release name>" (e.g.
// "2026-10-29 SolutionIQ-Local Release") — reformat the leading date to dd/mm/yyyy for the
// DM. A ticket can carry more than one fix version (comma-joined by the server), so each is
// reformatted independently.
function formatFixVersion(raw) {
  if (!raw) return '';
  return raw.split(',').map(part => {
    const v = part.trim();
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})\s*(.*)$/);
    if (!m) return v;
    const [, y, mo, d, rest] = m;
    return /release/i.test(rest) ? `${d}/${mo}/${y} release` : `${d}/${mo}/${y}${rest ? ` ${rest}` : ''}`;
  }).join(', ');
}

// The plain-text digest lines below are written by FeedbackByPerson.js/TimelineView.js in a
// fixed format we control on both ends, so pulling the real numbers back out of them (rather
// than asking the AI to retype numbers into a table) means the email's table can never disagree
// with the on-screen counts — the AI only ever writes the "What Was Done" sentences.
function parseDigest(message) {
  const lines = message.split('\n');
  const regionMatch = message.match(/^Weekly feedback summary — (.+)$/m);
  const isRegionDigest = !!regionMatch;
  const region = regionMatch ? regionMatch[1] : '';
  const projectMatch = message.match(/^Project: (.+)$/m);
  const project = projectMatch ? projectMatch[1] : 'the CoE Feedback Tracker';
  const breakdownMatch = message.match(/^Breakdown: (.+)$/m);
  const statusCounts = { done: 0, 'in-progress': 0, planned: 0, 'not-addressed': 0 };
  let total = 0;
  if (breakdownMatch) {
    CARE_ORDER.forEach(key => {
      const m = breakdownMatch[1].match(new RegExp(`(\\d+)\\s+${CARE_META[key].label}`));
      const n = m ? parseInt(m[1], 10) : 0;
      statusCounts[key] = n;
      total += n;
    });
  }
  const fixedExamples = [];
  const fixedIdx = lines.findIndex(l => l.trim() === 'Already fixed, examples:');
  if (fixedIdx !== -1) {
    for (let i = fixedIdx + 1; i < lines.length && lines[i].startsWith('• '); i++) {
      fixedExamples.push(parseExampleLine(lines[i].slice(2).trim()));
    }
  }
  const plannedExamples = [];
  const plannedIdx = lines.findIndex(l => l.trim() === 'Planned ahead, examples:');
  if (plannedIdx !== -1) {
    for (let i = plannedIdx + 1; i < lines.length && lines[i].startsWith('• '); i++) {
      plannedExamples.push(parseExampleLine(lines[i].slice(2).trim()));
    }
  }
  const contributors = [];
  const contribIdx = lines.findIndex(l => l.trim() === 'By contributor:');
  if (contribIdx !== -1) {
    for (let i = contribIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^• (.+?): (.+)$/);
      if (!m) break;
      contributors.push({ name: m[1], breakdown: m[2] });
    }
  }
  return { isRegionDigest, region, project, statusCounts, total, fixedExamples, plannedExamples, contributors };
}

// The only thing actually handed to the AI — short, grounded one-liners per highlighted item.
// Everything else (greeting, numbers, table structure, thank-you copy) is a fixed template, so
// it can never drift from what's on screen and always reads the same way every time.
// `kind` picks the framing: fixed items get a "what was done" sentence, planned items get a
// "what's planned next" sentence — kept as separate AI calls so the two never collapse into the
// same wording for an item that hasn't actually been done yet.
async function generateHighlightSentences(items, kind) {
  if (!items.length) return { texts: items, failed: false };
  const instruction = kind === 'planned'
    ? 'write ONE short sentence (plain, factual, business tone) describing what is planned to address it — phrase it as the upcoming plan/next step, not something already finished'
    : 'write ONE short sentence (plain, factual, business tone) describing what was fixed or improved — phrase it as the resolution/outcome, not a restatement of the problem';
  try {
    const text = await callFeedbackAI(
      `For each feedback item below, ${instruction}. Ground it only in that item's own wording, don't invent detail beyond what's given. Return ONLY a JSON array of strings, same order as the items, with no other text before or after it.\n\n${items.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
      500
    );
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (Array.isArray(parsed) && parsed.length === items.length) return { texts: parsed, failed: false };
    console.error(`generateHighlightSentences(${kind}): unexpected AI response shape`, text);
  } catch (err) {
    console.error(`generateHighlightSentences(${kind}) failed`, err);
  }
  return { texts: items, failed: true };
}

function buildEmailHtml(advisorName, digest, whatWasDone) {
  const { isRegionDigest, region, project, statusCounts, total, fixedExamples, plannedExamples, contributors } = digest;

  const scopeText = isRegionDigest
    ? `Here's an update on the feedback shared by the people you support in <strong>${escapeHtml(region)}</strong> for <strong>${escapeHtml(project)}</strong>. We've reviewed all <strong>${total} points</strong> and want to give you a clear overview of the status of each one.`
    : `Here's an update on the feedback you shared for <strong>${escapeHtml(project)}</strong>. We've reviewed all <strong>${total} points</strong> and want to give you a clear overview of the status of each one.`;

  const statusRows = CARE_ORDER.map(key => `
    <tr style="background:${CARE_META[key].bg};">
      <td style="padding:10px 14px;border:1px solid #e2e8f0;font-weight:600;">${CARE_META[key].icon} ${CARE_META[key].label}</td>
      <td style="padding:10px 14px;border:1px solid #e2e8f0;text-align:center;">${statusCounts[key]}</td>
    </tr>`).join('');

  const statusTable = `
    <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;margin:16px 0;">
      <tr style="background:#eef2f7;">
        <th style="padding:10px 14px;border:1px solid #e2e8f0;text-align:left;">Status</th>
        <th style="padding:10px 14px;border:1px solid #e2e8f0;text-align:center;">Count</th>
      </tr>
      ${statusRows}
      <tr style="background:#f1f3f5;">
        <td style="padding:10px 14px;border:1px solid #e2e8f0;font-weight:700;">Total</td>
        <td style="padding:10px 14px;border:1px solid #e2e8f0;text-align:center;font-weight:700;">${total}</td>
      </tr>
    </table>`;

  const highlightRows = [
    ...fixedExamples.map((e, i) => ({ item: e.summary, detail: whatWasDone[i] || e.summary, meta: CARE_META.done, priority: e.priority, fixVersion: e.fixVersion })),
    ...plannedExamples.map(e => ({ item: e.summary, detail: null, meta: CARE_META.planned, priority: e.priority, fixVersion: e.fixVersion }))
  ];
  // Priority/Fixed version stack directly under the status label, each on its own line —
  // same cell, quieter/smaller text, nothing shown at all for a row with neither set.
  const statusCellHtml = (meta, priority, fixVersion) => {
    const extra = [];
    if (priority) extra.push(`Priority: ${escapeHtml(priority)}`);
    if (fixVersion) extra.push(`Fixed version: ${escapeHtml(formatFixVersion(fixVersion))}`);
    const extraHtml = extra.map(line => `<br/><span style="color:#6b7280;font-size:12px;font-weight:400;">${line}</span>`).join('');
    return `${meta.icon} ${meta.label}${extraHtml}`;
  };
  const highlightsBlock = highlightRows.length ? `
    <p style="margin:16px 0 8px;">A few items worth highlighting:</p>
    <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;margin:8px 0 16px;">
      <tr style="background:#eef2f7;">
        <th style="padding:10px 14px;border:1px solid #e2e8f0;text-align:left;">Status</th>
        <th style="padding:10px 14px;border:1px solid #e2e8f0;text-align:left;">Feedback Item</th>
        <th style="padding:10px 14px;border:1px solid #e2e8f0;text-align:left;">Details</th>
      </tr>
      ${highlightRows.map(({ item, detail, meta, priority, fixVersion }) => `
        <tr style="background:${meta.bg};">
          <td style="padding:10px 14px;border:1px solid #e2e8f0;white-space:nowrap;vertical-align:top;">${statusCellHtml(meta, priority, fixVersion)}</td>
          <td style="padding:10px 14px;border:1px solid #e2e8f0;font-weight:600;vertical-align:top;">${escapeHtml(item)}</td>
          <td style="padding:10px 14px;border:1px solid #e2e8f0;vertical-align:top;">${detail !== null ? escapeHtml(detail) : ''}</td>
        </tr>`).join('')}
    </table>` : '';

  const contributorBlock = contributors.length ? `
    <p style="margin:16px 0 8px;"><strong>By contributor:</strong></p>
    <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;margin:8px 0 16px;">
      <tr style="background:#eef2f7;">
        <th style="padding:10px 14px;border:1px solid #e2e8f0;text-align:left;">Contributor</th>
        <th style="padding:10px 14px;border:1px solid #e2e8f0;text-align:left;">Status breakdown</th>
      </tr>
      ${contributors.map(c => `
        <tr>
          <td style="padding:10px 14px;border:1px solid #e2e8f0;font-weight:600;">${escapeHtml(c.name)}</td>
          <td style="padding:10px 14px;border:1px solid #e2e8f0;">${escapeHtml(c.breakdown)}</td>
        </tr>`).join('')}
    </table>` : '';

  const closing1 = isRegionDigest
    ? `Thank you again for everything you do to support ${escapeHtml(region)} — the detailed, thoughtful feedback your team shares is directly helping shape the improvements we're making to ${escapeHtml(project)}.`
    : `Thank you again for taking the time to provide such detailed and thoughtful feedback. The level of care and specificity you brought to each point has been incredibly valuable and is directly helping shape the improvements we're making to ${escapeHtml(project)}.`;

  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;">
    <p>Hi ${escapeHtml(advisorName)},</p>
    <p>${scopeText}</p>
    ${statusTable}
    ${highlightsBlock}
    ${contributorBlock}
    <p>${closing1}</p>
    <p>We'll continue to keep you updated as we work through the remaining items and will share additional progress as they are addressed.</p>
    <p>Thanks,</p>
  </div>`;
}

// Mirrors statusCellHtml's stacked layout — each extra fact gets its own indented line
// right under the status, nothing printed at all when neither is set on that ticket.
function tagLines(e) {
  const lines = [];
  if (e.priority) lines.push(`  Priority: ${e.priority}`);
  if (e.fixVersion) lines.push(`  Fixed version: ${formatFixVersion(e.fixVersion)}`);
  return lines;
}

function buildPlainText(advisorName, digest, whatWasDone) {
  const { isRegionDigest, region, project, statusCounts, total, fixedExamples, plannedExamples, contributors } = digest;
  const lines = [`Hi ${advisorName},`, ''];
  lines.push(isRegionDigest
    ? `Here's an update on the feedback shared by the people you support in ${region} for ${project}. We've reviewed all ${total} points and want to give you a clear overview of the status of each one.`
    : `Here's an update on the feedback you shared for ${project}. We've reviewed all ${total} points and want to give you a clear overview of the status of each one.`);
  lines.push('');
  CARE_ORDER.forEach(key => lines.push(`${CARE_META[key].icon} ${CARE_META[key].label}: ${statusCounts[key]}`));
  lines.push(`Total: ${total}`);
  if (fixedExamples.length || plannedExamples.length) {
    lines.push('', 'A few items worth highlighting:');
    fixedExamples.forEach((e, i) => {
      lines.push(`• [${CARE_META.done.label}] ${e.summary} — ${whatWasDone[i] || e.summary}`);
      tagLines(e).forEach(l => lines.push(l));
    });
    plannedExamples.forEach(e => {
      lines.push(`• [${CARE_META.planned.label}] ${e.summary}`);
      tagLines(e).forEach(l => lines.push(l));
    });
  }
  if (contributors.length) {
    lines.push('', 'By contributor:');
    contributors.forEach(c => lines.push(`• ${c.name}: ${c.breakdown}`));
  }
  lines.push('', isRegionDigest
    ? `Thank you again for everything you do to support ${region} — the detailed, thoughtful feedback your team shares is directly helping shape the improvements we're making to ${project}.`
    : `Thank you again for taking the time to provide such detailed and thoughtful feedback. The level of care and specificity you brought to each point has been incredibly valuable and is directly helping shape the improvements we're making to ${project}.`);
  lines.push("We'll continue to keep you updated as we work through the remaining items and will share additional progress as they are addressed.");
  lines.push('', 'Thanks,');
  return lines.join('\n');
}

// Clicking to reach out always drafts first — the person reviews the exact draft before anything
// sends, whether by Slack or email. When the digest carries real status counts (person/region
// updates), the draft is a deterministic, color-coded HTML table matching the app's own numbers,
// with AI used only for the short "what was fixed" sentences. Anything else (e.g. the Dev Lead
// "In Development" notice, which has no status breakdown to build a table from) falls back to a
// plain AI-drafted summary. Either way, the actual send is always a separate, deliberate click —
// nothing here fires on its own.
export default function SendToAdvisorButton({ advisorName, message, email }) {
  const [state, setState] = useState('idle'); // idle | drafting | ready | sending | sent | error
  const [draftHtml, setDraftHtml] = useState('');
  const [draftText, setDraftText] = useState('');
  const [draftSubject, setDraftSubject] = useState('');
  const [draftError, setDraftError] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copyStatus, setCopyStatus] = useState(''); // '' | 'copied' | 'failed'

  useEffect(() => { setState('idle'); setDraftHtml(''); setDraftText(''); setDraftError(''); }, [message]);

  async function startDraft(e) {
    e.stopPropagation();
    setState('drafting');
    setDraftError('');
    setCopyStatus('');
    const hasBreakdown = /^Breakdown:/m.test(message);
    try {
      if (hasBreakdown) {
        const digest = parseDigest(message);
        const { texts: whatWasDone, failed: fixedFailed } = await generateHighlightSentences(digest.fixedExamples.map(e => e.summary), 'done');
        setDraftHtml(buildEmailHtml(advisorName, digest, whatWasDone));
        setDraftText(buildPlainText(advisorName, digest, whatWasDone));
        setDraftSubject(`Feedback update — ${digest.project}${digest.isRegionDigest ? ` (${digest.region})` : ''}`);
        if (fixedFailed) setDraftError('Could not generate "What Was Done" summaries — showing the original item text instead. Check the browser console for details.');
      } else {
        const text = await callFeedbackAI(
          `You are a business advisor writing a professional status update to ${advisorName}. Format it like a real Slack DM / email:
1. A brief greeting line, e.g. "Hi ${advisorName},".
2. One short intro sentence on what this update covers.
3. Present the key counts (total items, how many people raised them) as short bullet points, using the exact numbers given below.
4. One short closing sentence that thanks them for their input and commits to keeping them updated as the remaining items progress — warm and appreciative, not consultant-speak (avoid jargon like "visibility," "backlog drift," "sprint assignments").
5. A brief sign-off line only (e.g. "Thanks,") — no name or title after it, the sender adds their own.
Keep every ticket key, number, and name exactly as given in the source below; don't invent or drop any of them.\n\n${message}`,
          650
        );
        const clean = text.trim();
        setDraftHtml('');
        setDraftText(clean || message);
        setDraftSubject((clean || message).split('\n')[0].slice(0, 200));
        if (!clean) setDraftError('AI summary came back empty — showing the full digest instead.');
      }
    } catch (err) {
      setDraftHtml('');
      setDraftText(message);
      setDraftSubject(message.split('\n')[0].slice(0, 200));
      setDraftError('Draft failed — showing the full digest instead.');
    } finally {
      setState('ready');
    }
  }

  async function confirmSend(e) {
    e.stopPropagation();
    setState('sending');
    try {
      await sendSlackDM(email, draftText);
      setState('sent');
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setErrorMsg(err.message);
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }

  async function copyFormattedEmail(e) {
    e.stopPropagation();
    try {
      if (draftHtml && navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([
          new window.ClipboardItem({
            'text/html': new Blob([draftHtml], { type: 'text/html' }),
            'text/plain': new Blob([draftText], { type: 'text/plain' })
          })
        ]);
      } else {
        await navigator.clipboard.writeText(draftText);
      }
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus(''), 1800);
    } catch (err) {
      setCopyStatus('failed');
      setTimeout(() => setCopyStatus(''), 2500);
    }
  }

  function mailtoHref() {
    return `mailto:${email || ''}?subject=${encodeURIComponent(draftSubject)}&body=${encodeURIComponent(draftText)}`;
  }

  if (state === 'idle') {
    return (
      <button onClick={startDraft} style={styles.btn} title={`Drafts a professional summary for ${advisorName} — you review it before anything sends`}>
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
        {draftHtml
          ? <div dangerouslySetInnerHTML={{ __html: draftHtml }} />
          : <div style={{ whiteSpace: 'pre-wrap' }}>{draftText}</div>}
      </div>
      {draftError && <span style={{ fontSize: 11, color: '#b91c1c' }}>{draftError}</span>}
      {draftHtml && !draftError && (
        <span style={{ fontSize: 11, color: '#9ca3af' }}>Colors/table only show up once pasted into an email body (Slack shows plain text instead) — mailto can't carry them.</span>
      )}
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {state === 'ready' && email && (
          <button onClick={confirmSend} style={styles.btnPrimary}>💬 Send via Slack</button>
        )}
        {state === 'ready' && email && (
          <a href={mailtoHref()} style={styles.emailBtn}>✉️ Open Email Draft</a>
        )}
        {state === 'ready' && draftHtml && (
          <button onClick={copyFormattedEmail} style={styles.btn}>📋 Copy formatted email</button>
        )}
        {state === 'ready' && !email && !draftHtml && (
          <button onClick={copyFormattedEmail} style={styles.btn}>📋 Copy for advisor</button>
        )}
        {state === 'ready' && <button onClick={startDraft} style={styles.regenBtn}>↻ Regenerate</button>}
        {state === 'ready' && <button onClick={() => setState('idle')} style={styles.cancelBtn}>Cancel</button>}
        {state === 'sending' && <span style={{ fontSize: 12, color: '#6b7280' }}>Sending…</span>}
        {state === 'sent' && <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>Sent ✓</span>}
        {state === 'error' && <span style={{ fontSize: 12, color: '#b91c1c' }}>Failed: {errorMsg}</span>}
        {copyStatus === 'copied' && <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>Copied ✓</span>}
        {copyStatus === 'failed' && <span style={{ fontSize: 12, color: '#b91c1c' }}>Copy failed — select the preview above and copy manually</span>}
      </span>
      {!email && state === 'ready' && (
        <span style={{ fontSize: 11, color: '#9ca3af' }}>No email on file yet for {advisorName} — copy the draft instead</span>
      )}
      {email && draftHtml && (
        <span style={{ fontSize: 11, color: '#9ca3af' }}>Tip: click "Open Email Draft" to address it, then paste the copied formatted email over the plain-text body.</span>
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
  preview: { fontSize: 12.5, color: '#374151', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, padding: '10px 12px', maxWidth: 620, lineHeight: 1.4, overflowX: 'auto' }
};
