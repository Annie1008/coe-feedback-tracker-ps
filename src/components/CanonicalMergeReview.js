import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { confirmCandidate, generateCandidates, listCandidates, rejectCandidate } from '../canonicalApi';

const TOKEN_KEY = 'canonicalMergeReviewToken';

function errorMessage(error) {
  if (error.status === 401) return 'The review token was not accepted. Correct the token and try again.';
  if (error.status === 503) return 'Merge review is unavailable because the server review token is not configured.';
  return error.message || 'The merge review request failed. Try again.';
}

function CanonicalSummary({ side, canonical }) {
  return (
    <section className="merge-review-summary" aria-labelledby={`${side}-${canonical.id}-heading`}>
      <h4 id={`${side}-${canonical.id}-heading`}>{canonical.title || `${side} canonical feedback`}</h4>
      <p className="merge-review-summary-preview">{canonical.text || 'No canonical summary was returned.'}</p>
      <details>
        <summary>Expand full canonical summary</summary>
        <p>{canonical.text || 'No canonical summary was returned.'}</p>
      </details>
      <dl className="merge-review-counts">
        <div><dt>Submissions</dt><dd>{canonical.submissionCount}</dd></div>
        <div><dt>Providers returned</dt><dd>{canonical.providers.length}</dd></div>
      </dl>
      {canonical.providers.length > 0 && <p><strong>Providers:</strong> {canonical.providers.join(', ')}</p>}
    </section>
  );
}

function ConfirmDialog({ candidate, winnerId, onCancel, onConfirm, saving }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  const savingRef = useRef(saving);
  onCancelRef.current = onCancel;
  savingRef.current = saving;
  const winner = candidate.left.id === winnerId ? candidate.left : candidate.right;
  const loser = candidate.left.id === winnerId ? candidate.right : candidate.left;

  useEffect(() => {
    const appRoot = document.querySelector('#root');
    const rootWasInert = appRoot?.hasAttribute('inert');
    appRoot?.setAttribute('inert', '');
    cancelRef.current?.focus();
    function onKeyDown(event) {
      if (event.key === 'Escape' && !savingRef.current) { event.preventDefault(); onCancelRef.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialogRef.current?.querySelectorAll('button:not([disabled])') || []);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (!rootWasInert) appRoot?.removeAttribute('inert');
    };
  }, []);

  return (
    <div className="merge-review-dialog-backdrop">
      <div ref={dialogRef} className="merge-review-dialog" role="dialog" aria-modal="true"
        aria-labelledby="merge-confirm-title" aria-describedby="merge-confirm-description">
        <h3 id="merge-confirm-title">Confirm historical canonical merge</h3>
        <div id="merge-confirm-description">
          <p><strong>{winner.title || winner.text}</strong> will survive.</p>
          <p><strong>{loser.title || loser.text}</strong> will become an alias. Its submissions will move to the survivor, while original submission evidence is retained.</p>
          <p>Existing Feedback Analysis and other legacy views are not changed by this action yet.</p>
        </div>
        <div className="merge-review-actions">
          <button ref={cancelRef} type="button" onClick={() => { if (!saving) onCancel(); }} aria-disabled={saving}>Cancel</button>
          <button type="button" className="merge-review-primary" onClick={onConfirm} disabled={saving}>
            {saving ? 'Confirming…' : 'Confirm merge'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CanonicalMergeReview({ initiativeId, initiativeName }) {
  const [tokenInput, setTokenInput] = useState('');
  const [activeToken, setActiveToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [candidates, setCandidates] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [winners, setWinners] = useState({});
  const [reasons, setReasons] = useState({});
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [dialogCandidate, setDialogCandidate] = useState(null);
  const [invalidCandidateId, setInvalidCandidateId] = useState(null);
  const reasonRefs = useRef({});
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!dialogCandidate) return undefined;
    return () => {
      triggerRef.current?.focus();
    };
  }, [dialogCandidate]);

  async function load({ cursor, append = false, reviewToken = activeToken } = {}) {
    if (!reviewToken) return;
    setBusy(true); setError(''); setStatus('Loading pending candidates…');
    try {
      const result = await listCandidates({ initiativeId, token: reviewToken, cursor });
      setCandidates(current => append ? [...current, ...result.items] : result.items);
      setNextCursor(result.nextCursor);
      setStatus(`${result.items.length} pending candidate${result.items.length === 1 ? '' : 's'} loaded${append ? ' in this page' : ''}.`);
      return true;
    } catch (requestError) {
      setError(errorMessage(requestError)); setStatus('');
      return false;
    } finally { setBusy(false); }
  }

  async function submitToken(event) {
    event.preventDefault();
    if (!tokenInput) { setError('Enter the review token.'); return; }
    setBusy(true); setError(''); setStatus('Generating lexical duplicate candidates…');
    try {
      const result = await generateCandidates({ initiativeId, token: tokenInput });
      sessionStorage.setItem(TOKEN_KEY, tokenInput);
      setActiveToken(tokenInput);
      setTokenInput('');
      setStatus(`Generation complete: ${result.generated} new and ${result.refreshed} refreshed. Loading pending candidates…`);
      const loaded = await load({ reviewToken: tokenInput });
      if (!loaded) setStatus(`Generation complete: ${result.generated} new and ${result.refreshed} refreshed, but the pending list could not be loaded. Try refreshing it.`);
    } catch (requestError) {
      setError(errorMessage(requestError)); setStatus(''); setBusy(false);
    }
  }

  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
    setTokenInput(''); setActiveToken(''); setCandidates([]); setNextCursor(null); setError(''); setStatus('Review token cleared for this session.');
  }

  async function generate() {
    setBusy(true); setError(''); setStatus('Generating lexical duplicate candidates…');
    try {
      const result = await generateCandidates({ initiativeId, token: activeToken });
      setStatus(`Generation complete: ${result.generated} new and ${result.refreshed} refreshed. Loading pending candidates…`);
      const loaded = await load({ reviewToken: activeToken });
      if (!loaded) setStatus(`Generation complete: ${result.generated} new and ${result.refreshed} refreshed, but the pending list could not be loaded. Try refreshing it.`);
    } catch (requestError) {
      setError(errorMessage(requestError)); setStatus(''); setBusy(false);
    }
  }

  async function reject(candidate) {
    setSavingId(candidate.id); setError('');
    try {
      await rejectCandidate({ candidate, reason: reasons[candidate.id] || '', token: activeToken });
      setCandidates(current => current.filter(item => item.id !== candidate.id));
      setStatus('Candidate rejected and removed from the pending list.');
    } catch (requestError) {
      if (requestError.status === 409) {
        setStatus('This candidate changed while you were reviewing it. The pending list was refreshed.');
        await load({ reviewToken: activeToken });
      } else setError(errorMessage(requestError));
    } finally { setSavingId(null); }
  }

  function requestConfirm(candidate, trigger) {
    if (!(reasons[candidate.id] || '').trim()) {
      setInvalidCandidateId(candidate.id);
      setError('Enter a reason before confirming this merge.');
      reasonRefs.current[candidate.id]?.focus();
      return;
    }
    triggerRef.current = trigger;
    setInvalidCandidateId(null); setError(''); setDialogCandidate(candidate);
  }

  async function confirm() {
    const candidate = dialogCandidate;
    setSavingId(candidate.id); setError('');
    try {
      await confirmCandidate({ candidate, winnerId: winners[candidate.id] || candidate.left.id, reason: reasons[candidate.id], token: activeToken });
      const reloaded = await load({ reviewToken: activeToken });
      setStatus(reloaded
        ? 'Merge confirmed. The pending list was reloaded.'
        : 'Merge confirmed, but the pending list could not be reloaded. Try loading it again.');
      setDialogCandidate(null);
    } catch (requestError) {
      setDialogCandidate(null);
      if (requestError.status === 409) {
        setStatus('This candidate or canonical feedback changed. The pending list was refreshed.');
        await load({ reviewToken: activeToken });
      } else setError(errorMessage(requestError));
    } finally { setSavingId(null); }
  }

  return (
    <div className="merge-review" aria-busy={busy}>
      <div>
        <h2>Merge Review — {initiativeName}</h2>
        <p className="merge-review-banner"><strong>Canonical review only:</strong> existing Feedback Analysis, Timeline, and legacy views will continue showing their current grouping until the later UI cutover.</p>
        <p>This review uses lexical backend matching only. Semantic AI review can be added when a shared or personal integration is available; this UI does not call a personal AI key.</p>

        <form onSubmit={submitToken} className="merge-review-token-form">
          <div>
            <label htmlFor="merge-review-token">Session review token</label>
            <input id="merge-review-token" type="password" value={tokenInput} autoComplete="off"
              onChange={event => setTokenInput(event.target.value)} aria-describedby="merge-review-token-help" />
            <p id="merge-review-token-help">Stored only in this browser tab's session storage. It is never displayed after entry.</p>
          </div>
          <button type="submit" disabled={busy || !tokenInput}>Generate and load candidates</button>
          <button type="button" onClick={clearToken} disabled={!activeToken || busy || Boolean(savingId)}>Clear token</button>
        </form>

        {activeToken && <div className="merge-review-actions">
          <button type="button" className="merge-review-primary" onClick={generate} disabled={busy || Boolean(savingId)}>Regenerate candidates</button>
          <button type="button" onClick={() => load()} disabled={busy || Boolean(savingId)}>Refresh pending list</button>
        </div>}
        <p className="merge-review-status" role="status" aria-live="polite">{status}</p>
        {error && <p className="merge-review-error" role="alert">{error}</p>}

        <div className="merge-review-list">
          {candidates.map((candidate, index) => {
            const winnerId = winners[candidate.id] || candidate.left.id;
            const disabled = savingId === candidate.id;
            return (
              <article key={candidate.id} className="merge-review-card" aria-labelledby={`candidate-${candidate.id}`}>
                <h3 id={`candidate-${candidate.id}`}>Candidate {index + 1}</h3>
                <p><strong>Similarity score:</strong> {candidate.score === null ? 'Not returned' : `${Math.round(candidate.score * 100)}%`}</p>
                <p><strong>Match type:</strong> {candidate.evidence?.exactNormalized ? 'Exact normalized match' : 'Lexical similarity match'}</p>
                <div className="merge-review-grid">
                  <CanonicalSummary side="Left" canonical={candidate.left} />
                  <CanonicalSummary side="Right" canonical={candidate.right} />
                </div>
                <fieldset disabled={disabled}>
                  <legend>Choose the canonical feedback that should survive</legend>
                  <label htmlFor={`winner-left-${candidate.id}`}>
                    <input id={`winner-left-${candidate.id}`} type="radio" name={`winner-${candidate.id}`} value={candidate.left.id}
                      checked={winnerId === candidate.left.id} onChange={() => setWinners(current => ({ ...current, [candidate.id]: candidate.left.id }))} />
                    Keep left: {candidate.left.title || candidate.left.text}
                  </label>
                  <label htmlFor={`winner-right-${candidate.id}`}>
                    <input id={`winner-right-${candidate.id}`} type="radio" name={`winner-${candidate.id}`} value={candidate.right.id}
                      checked={winnerId === candidate.right.id} onChange={() => setWinners(current => ({ ...current, [candidate.id]: candidate.right.id }))} />
                    Keep right: {candidate.right.title || candidate.right.text}
                  </label>
                </fieldset>
                <label htmlFor={`reason-${candidate.id}`}>Review reason <span>(required to confirm; recommended when rejecting)</span></label>
                <textarea id={`reason-${candidate.id}`} value={reasons[candidate.id] || ''} maxLength={2000} disabled={disabled}
                  ref={element => { reasonRefs.current[candidate.id] = element; }}
                  aria-invalid={invalidCandidateId === candidate.id}
                  aria-describedby={invalidCandidateId === candidate.id ? `reason-error-${candidate.id}` : undefined}
                  onChange={event => {
                    setReasons(current => ({ ...current, [candidate.id]: event.target.value }));
                    if (invalidCandidateId === candidate.id) { setInvalidCandidateId(null); setError(''); }
                  }} />
                {invalidCandidateId === candidate.id && <p id={`reason-error-${candidate.id}`} className="merge-review-field-error">Enter a reason before confirming this merge.</p>}
                <div className="merge-review-actions">
                  <button type="button" onClick={() => reject(candidate)} disabled={busy || disabled || Boolean(savingId)}>{disabled ? 'Saving…' : 'Reject candidate'}</button>
                  <button type="button" className="merge-review-primary" disabled={busy || disabled || Boolean(savingId)}
                    onClick={event => requestConfirm(candidate, event.currentTarget)}>Review and confirm merge</button>
                </div>
              </article>
            );
          })}
        </div>
        {nextCursor && <button type="button" onClick={() => load({ cursor: nextCursor, append: true })} disabled={busy || Boolean(savingId)}>Load more</button>}
      </div>
      {dialogCandidate && createPortal(
        <ConfirmDialog candidate={dialogCandidate} winnerId={winners[dialogCandidate.id] || dialogCandidate.left.id}
          saving={savingId === dialogCandidate.id} onCancel={() => setDialogCandidate(null)} onConfirm={confirm} />,
        document.body
      )}
    </div>
  );
}
