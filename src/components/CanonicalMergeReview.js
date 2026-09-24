import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { confirmGroup, generateCandidates, listGroups, rejectCandidate } from '../canonicalApi';

const TOKEN_KEY = 'canonicalMergeReviewToken';

function errorMessage(error) {
  if (error.status === 401) return 'The review token was not accepted. Correct the token and try again.';
  if (error.status === 503) return 'Merge review is unavailable because the server review token is not configured.';
  return error.message || 'The merge review request failed. Try again.';
}

function generationStatus(result) {
  return `Generation complete: ${result.generated} new and ${result.refreshed} refreshed${result.recovered ? ` and ${result.recovered} recovered` : ''}.`;
}

function CanonicalSummary({ groupId, memberIndex, canonical }) {
  const heading = `${groupId}-member-${memberIndex}-heading`;
  return <section className="merge-review-summary" aria-labelledby={heading}>
    <h4 id={heading}>{canonical.title || 'Canonical feedback'}</h4>
    <p className="merge-review-summary-preview">{canonical.text || 'No canonical summary was returned.'}</p>
    <details><summary>Expand full canonical summary</summary><p>{canonical.text || 'No canonical summary was returned.'}</p></details>
    <dl className="merge-review-counts"><div><dt>Submissions</dt><dd>{canonical.submissionCount}</dd></div><div><dt>Providers returned</dt><dd>{canonical.providers.length}</dd></div></dl>
    {canonical.providers.length > 0 && <p><strong>Providers:</strong> {canonical.providers.join(', ')}</p>}
  </section>;
}

function ConfirmDialog({ group, winnerId, onCancel, onConfirm, saving }) {
  const dialogRef = useRef(null); const cancelRef = useRef(null); const onCancelRef = useRef(onCancel); const savingRef = useRef(saving);
  onCancelRef.current = onCancel; savingRef.current = saving;
  const winner = group.members.find(member => member.id === winnerId);
  useEffect(() => {
    const appRoot = document.querySelector('#root'); const rootWasInert = appRoot?.hasAttribute('inert'); appRoot?.setAttribute('inert', ''); cancelRef.current?.focus();
    function onKeyDown(event) {
      if (event.key === 'Escape' && !savingRef.current) { event.preventDefault(); onCancelRef.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialogRef.current?.querySelectorAll('button:not([disabled])') || []); if (!controls.length) return;
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); if (!rootWasInert) appRoot?.removeAttribute('inert'); };
  }, []);
  return <div className="merge-review-dialog-backdrop"><div ref={dialogRef} className="merge-review-dialog" role="dialog" aria-modal="true" aria-labelledby="merge-confirm-title" aria-describedby="merge-confirm-description">
    <h3 id="merge-confirm-title">Confirm grouped canonical merge</h3><div id="merge-confirm-description">
      <p><strong>{winner.title || winner.text}</strong> will survive.</p><p>All other records in this group will become aliases. Their submissions, actions, and closed loops will move to the survivor.</p><p>Existing Feedback Analysis and other legacy views are not changed by this action yet.</p>
    </div><div className="merge-review-actions"><button ref={cancelRef} type="button" onClick={() => { if (!saving) onCancel(); }} aria-disabled={saving}>Cancel</button><button type="button" className="merge-review-primary" onClick={onConfirm} disabled={saving}>{saving ? 'Confirming…' : 'Confirm group merge'}</button></div>
  </div></div>;
}

export default function CanonicalMergeReview({ initiativeId, initiativeName }) {
  const [tokenInput, setTokenInput] = useState(''); const [activeToken, setActiveToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [groups, setGroups] = useState([]); const [nextCursor, setNextCursor] = useState(null); const [winners, setWinners] = useState({}); const [reasons, setReasons] = useState({});
  const [status, setStatus] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [savingId, setSavingId] = useState(null); const [dialogGroup, setDialogGroup] = useState(null); const [invalidGroupId, setInvalidGroupId] = useState(null);
  const reasonRefs = useRef({}); const triggerRef = useRef(null); const headingRef = useRef(null); const attemptKeysRef = useRef({});
  async function load({ cursor, append = false, reviewToken = activeToken } = {}) {
    if (!reviewToken) return; setBusy(true); setError(''); setStatus('Loading pending groups…');
    try { const result = await listGroups({ initiativeId, token: reviewToken, cursor }); setGroups(current => append ? [...current, ...result.groups] : result.groups); setNextCursor(result.nextCursor); setStatus(`${result.groups.length} pending group${result.groups.length === 1 ? '' : 's'} loaded.`); return true; }
    catch (requestError) { setError(errorMessage(requestError)); setStatus(''); return false; } finally { setBusy(false); }
  }
  async function submitToken(event) { event.preventDefault(); if (!tokenInput) { setError('Enter the review token.'); return; } setBusy(true); setError('');
    try { const result = await generateCandidates({ initiativeId, token: tokenInput }); sessionStorage.setItem(TOKEN_KEY, tokenInput); setActiveToken(tokenInput); setTokenInput(''); await load({ reviewToken: tokenInput }); setStatus(generationStatus(result)); } catch (requestError) { setError(errorMessage(requestError)); setBusy(false); } }
  function clearToken() { sessionStorage.removeItem(TOKEN_KEY); setTokenInput(''); setActiveToken(''); setGroups([]); setNextCursor(null); setError(''); setStatus('Review token cleared for this session.'); }
  async function generate() { setBusy(true); setError(''); try { const result = await generateCandidates({ initiativeId, token: activeToken }); await load({ reviewToken: activeToken }); setStatus(generationStatus(result)); } catch (requestError) { setError(errorMessage(requestError)); setBusy(false); } }
  async function reject(group) { const candidate = { id: group.edges[0].id, version: group.edges[0].version }; setSavingId(group.id); try { await rejectCandidate({ candidate, reason: reasons[group.id] || '', token: activeToken }); await load({ reviewToken: activeToken }); } catch (requestError) { setError(errorMessage(requestError)); } finally { setSavingId(null); } }
  function requestConfirm(group, trigger) { if (!(reasons[group.id] || '').trim()) { setInvalidGroupId(group.id); setError('Enter a reason before confirming this merge.'); reasonRefs.current[group.id]?.focus(); return; } triggerRef.current = trigger; attemptKeysRef.current[group.id] ||= globalThis.crypto.randomUUID(); setInvalidGroupId(null); setError(''); setDialogGroup(group); }
  function cancelConfirm() { const group = dialogGroup; if (group) delete attemptKeysRef.current[group.id]; setDialogGroup(null); setTimeout(() => triggerRef.current?.focus(), 0); }
  async function confirm() { const group = dialogGroup; setSavingId(group.id); setError(''); try { await confirmGroup({ group, winnerId: winners[group.id] || group.members[0].id, reason: reasons[group.id], token: activeToken, idempotencyKey: attemptKeysRef.current[group.id] }); const reloaded = await load({ reviewToken: activeToken }); setStatus(reloaded ? 'Merge confirmed. The pending list was reloaded.' : 'Merge confirmed, but the pending list could not be reloaded.'); delete attemptKeysRef.current[group.id]; setDialogGroup(null); setTimeout(() => headingRef.current?.focus(), 0); } catch (requestError) { setDialogGroup(null); setError(errorMessage(requestError)); setTimeout(() => triggerRef.current?.focus(), 0); } finally { setSavingId(null); } }
  return <div className="merge-review" aria-busy={busy}><div><h2 ref={headingRef} tabIndex={-1}>Merge Review — {initiativeName}</h2><p className="merge-review-banner"><strong>Canonical review only:</strong> existing Feedback Analysis, Timeline, and legacy views will continue showing their current grouping until the later UI cutover.</p><p>This review uses lexical backend matching only.</p>
    <form onSubmit={submitToken} className="merge-review-token-form"><div><label htmlFor="merge-review-token">Session review token</label><input id="merge-review-token" type="password" value={tokenInput} autoComplete="off" onChange={event => setTokenInput(event.target.value)} aria-describedby="merge-review-token-help"/><p id="merge-review-token-help">Stored only in this browser tab's session storage.</p></div><button type="submit" disabled={busy || !tokenInput}>Generate and load candidates</button><button type="button" onClick={clearToken} disabled={!activeToken || busy || Boolean(savingId)}>Clear token</button></form>
    {activeToken && <div className="merge-review-actions"><button type="button" className="merge-review-primary" onClick={generate} disabled={busy || Boolean(savingId)}>Regenerate candidates</button><button type="button" onClick={() => load()} disabled={busy || Boolean(savingId)}>Refresh pending list</button></div>}<p className="merge-review-status" role="status" aria-live="polite">{status}</p>{error && <p className="merge-review-error" role="alert">{error}</p>}
    <div className="merge-review-list">{groups.map(group => { const winnerId = winners[group.id] || group.members[0].id; const disabled = savingId === group.id; return <article key={group.id} className="merge-review-card" aria-labelledby={`group-${group.id}`}><h3 id={`group-${group.id}`}>Group of {group.members.length} matching records</h3>
      <div className="merge-review-grid">{group.members.map((member, memberIndex) => <CanonicalSummary key={member.id} groupId={group.id} memberIndex={memberIndex} canonical={member}/>)}</div><section aria-labelledby={`evidence-${group.id}`}><h4 id={`evidence-${group.id}`}>Similarity evidence</h4><ul>{group.edges.map(edge => <li key={edge.id}>{edge.leftId} ↔ {edge.rightId}: {Math.round(edge.score * 100)}% — {edge.evidence?.exactNormalized ? 'exact normalized match' : 'lexical similarity'}</li>)}</ul></section>
      <fieldset disabled={disabled}><legend>Choose the canonical feedback that should survive</legend>{group.members.map((member, memberIndex) => <label key={member.id} htmlFor={`winner-${group.id}-${memberIndex}`}><input id={`winner-${group.id}-${memberIndex}`} type="radio" name={`winner-${group.id}`} checked={winnerId === member.id} onChange={() => setWinners(current => ({ ...current, [group.id]: member.id }))}/>Keep: {member.title || member.text}</label>)}</fieldset>
      <label htmlFor={`reason-${group.id}`}>Review reason <span>(required to confirm)</span></label><textarea id={`reason-${group.id}`} value={reasons[group.id] || ''} maxLength={2000} disabled={disabled} ref={element => { reasonRefs.current[group.id] = element; }} aria-invalid={invalidGroupId === group.id} aria-describedby={invalidGroupId === group.id ? `reason-error-${group.id}` : undefined} onChange={event => setReasons(current => ({ ...current, [group.id]: event.target.value }))}/>{invalidGroupId === group.id && <p id={`reason-error-${group.id}`} className="merge-review-field-error">Enter a reason before confirming this merge.</p>}
      <div className="merge-review-actions">{group.members.length === 2 && <button type="button" onClick={() => reject(group)} disabled={busy || disabled || Boolean(savingId)}>Reject pair</button>}<button type="button" className="merge-review-primary" disabled={busy || disabled || Boolean(savingId)} onClick={event => requestConfirm(group, event.currentTarget)}>Review and confirm group merge</button></div></article>; })}</div>{nextCursor && <button type="button" onClick={() => load({ cursor: nextCursor, append: true })} disabled={busy || Boolean(savingId)}>Load more</button>}
  </div>{dialogGroup && createPortal(<ConfirmDialog group={dialogGroup} winnerId={winners[dialogGroup.id] || dialogGroup.members[0].id} saving={savingId === dialogGroup.id} onCancel={cancelConfirm} onConfirm={confirm}/>, document.body)}</div>;
}
