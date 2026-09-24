import fs from 'node:fs';
import path from 'node:path';
import { confirmCandidate, confirmGroup, generateCandidates, listCandidates, listGroups, rejectCandidate } from '../canonicalApi';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('canonical merge client scopes list requests and sends only protected-call headers', async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); return response({ groups: [], nextCursor: null }); };

  await listCandidates({ initiativeId: 'initiative/1', token: 'session-secret', cursor: 'next token', fetchImpl: request });

  expect(calls[0][0]).toContain('initiativeId=initiative%2F1');
  expect(calls[0][0]).toContain('cursor=next+token');
  expect(calls[0][1].headers).toEqual({ 'x-merge-review-token': 'session-secret' });
});

test('legacy pair exports remain compatible while group listing uses the new endpoint', async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); return response({ items: [], groups: [], nextCursor: null }); };
  await listCandidates({ initiativeId: 'i1', token: 'secret', fetchImpl: request });
  await listGroups({ initiativeId: 'i1', token: 'secret', fetchImpl: request });
  await confirmCandidate({ candidate: { id: 'd1', version: 2, left: { id: 'a', version: 1 }, right: { id: 'b', version: 1 } }, winnerId: 'a', reason: 'same', token: 'secret', fetchImpl: request, randomUUID: () => 'pair-confirm-key-1' });
  expect(calls[0][0]).toContain('/duplicate-candidates?');
  expect(calls[1][0]).toContain('/duplicate-groups?');
  expect(calls[2][0]).toContain('/duplicate-candidates/d1/confirm');
});

test('canonical merge mutations send safe payloads, versions, and unique idempotency keys', async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); return response({}); };
  const ids = ['generate-idempotency', 'reject-idempotency', 'confirm-idempotency'];
  const randomUUID = () => ids.shift();

  await generateCandidates({ initiativeId: 'i1', token: 'secret', fetchImpl: request, randomUUID });
  await rejectCandidate({ candidate: { id: 'd1', version: 2 }, reason: '', token: 'secret', fetchImpl: request, randomUUID });
  await confirmGroup({
    group: { id: 'group:a,b', members: [{ id: 'a', version: 3 }, { id: 'b', version: 4 }], edges: [{ id: 'd1', version: 2 }] },
    winnerId: 'b', reason: 'Same historical point', token: 'secret', fetchImpl: request, randomUUID
  });

  expect(JSON.parse(calls[0][1].body)).toEqual({ initiativeId: 'i1', threshold: 0.45, limitPerItem: 10 });
  expect(calls.map(call => call[1].headers['Idempotency-Key'])).toEqual([
    'generate-idempotency', 'reject-idempotency', 'confirm-idempotency'
  ]);
  expect(JSON.parse(calls[1][1].body)).toEqual({ expectedVersion: 2, reason: '' });
  expect(calls[2][0]).toContain('/api/canonical/duplicate-groups/group%3Aa%2Cb/confirm');
  expect(JSON.parse(calls[2][1].body)).toEqual({ winnerId: 'b', members: [{ id: 'a', expectedVersion: 3 }, { id: 'b', expectedVersion: 4 }], edges: [{ id: 'd1', expectedVersion: 2 }], reason: 'Same historical point' });
});

test('InitiativeDetail exposes an initiative-scoped Merge Review beside Feedback Analysis', () => {
  const source = fs.readFileSync(path.join(__dirname, 'InitiativeDetail.js'), 'utf8');

  expect(source).toContain("'Feedback Analysis', 'Merge Review'");
  expect(source).toMatch(/<CanonicalMergeReview\s+initiativeId=\{initiativeId\}\s+initiativeName=\{initiative\.name\}/);
});

test('Merge Review source includes required accessible review and dialog semantics', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanonicalMergeReview.js'), 'utf8');

  for (const required of [
    'type="password"', '<article', '<fieldset', '<legend', 'role="dialog"', 'aria-modal="true"',
    'role="status"', 'role="alert"', 'Canonical review only:', '<details>', '<summary>'
  ]) expect(source).toContain(required);
  expect(source).not.toContain('dangerouslySetInnerHTML');
  expect(source).not.toContain('localStorage');
  expect(source).not.toContain('callFeedbackAI');
});

test('Merge Review generates with the draft token before activating, storing, and loading it', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanonicalMergeReview.js'), 'utf8');

  expect(source).toContain('const [tokenInput, setTokenInput]');
  expect(source).toContain('const [activeToken, setActiveToken]');
  expect(source).toMatch(/async function submitToken[\s\S]*await generateCandidates\(\{ initiativeId, token: tokenInput \}\)[\s\S]*sessionStorage\.setItem\(TOKEN_KEY, tokenInput\)[\s\S]*setActiveToken\(tokenInput\)[\s\S]*await load\(\{ reviewToken: tokenInput \}\)/);
  expect(source).toMatch(/<button type="submit"[^>]*>Generate and load candidates<\/button>/);
  expect(source).toMatch(/setTokenInput\(''\)/);
});

test('Merge Review exposes distinct regenerate and GET-only refresh actions for the active token', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanonicalMergeReview.js'), 'utf8');

  expect(source).toMatch(/onClick=\{generate\}[^>]*>Regenerate candidates<\/button>/);
  expect(source).toMatch(/onClick=\{\(\) => load\(\)\}[^>]*>Refresh pending list<\/button>/);
  expect(source).toMatch(/className="merge-review"[^>]*aria-busy=\{busy\}/);
  expect(source).toMatch(/onClick=\{clearToken\} disabled=\{!activeToken \|\| busy \|\| Boolean\(savingId\)\}/);
  expect(source).toContain('group.members.length === 2');
  expect(source).toMatch(/className="merge-review-primary" disabled=\{busy \|\| disabled \|\| Boolean\(savingId\)\}/);
});

test('Merge Review generation status reports recovered candidates when present', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanonicalMergeReview.js'), 'utf8');
  expect(source).toMatch(/result\.recovered[\s\S]*recovered/);
  expect(source).toMatch(/Generation complete:[\s\S]*generated[\s\S]*refreshed[\s\S]*recovered/);
});

test('Merge Review reloads after a confirmed merge', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanonicalMergeReview.js'), 'utf8');

  expect(source).toMatch(/await confirmGroup[\s\S]*await load\(\{ reviewToken: activeToken \}\)/);
  expect(source).toContain('Merge confirmed. The pending list was reloaded.');
});

test('Merge Review retains a group attempt key across failure and focuses persistent content after success', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanonicalMergeReview.js'), 'utf8');
  expect(source).toContain('attemptKeysRef');
  expect(source).toMatch(/idempotencyKey:\s*attemptKeysRef\.current\[group\.id\]/);
  expect(source).toMatch(/delete attemptKeysRef\.current\[group\.id\][\s\S]*headingRef\.current\?\.focus/);
  expect(source).toMatch(/catch \(requestError\)[\s\S]*setDialogGroup\(null\)[\s\S]*triggerRef\.current\?\.focus/);
  expect(source).toMatch(/<h2[^>]*ref=\{headingRef\}[^>]*tabIndex=\{-1\}/);
});

test('Merge Review labels groups, renders every member and edge, and only rejects size-two pairs', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanonicalMergeReview.js'), 'utf8');
  expect(source).toContain('Group of {group.members.length} matching records');
  expect(source).toMatch(/group\.members\.map/);
  expect(source).toMatch(/group\.edges\.map/);
  expect(source).toContain('group.members.length === 2');
  expect(source).toContain('All other records in this group will become aliases');
  expect(source).toMatch(/memberIndex/);
  expect(source).not.toMatch(/id=\{`[^`]*\$\{canonical\.id\}/);
  expect(source).not.toMatch(/id=\{`winner-\$\{group\.id\}-\$\{member\.id\}/);
});

test('Merge Review identifies and focuses the group-specific missing reason', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanonicalMergeReview.js'), 'utf8');

  expect(source).toContain('invalidGroupId');
  expect(source).toContain('reasonRefs');
  expect(source).toMatch(/aria-invalid=\{invalidGroupId === group\.id\}/);
  expect(source).toMatch(/aria-describedby=\{invalidGroupId === group\.id/);
  expect(source).toContain('Enter a reason before confirming this merge.');
});

test('Merge Review portals its modal outside the inert app root and keeps a focus trap while saving', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanonicalMergeReview.js'), 'utf8');

  expect(source).toContain("import { createPortal } from 'react-dom'");
  expect(source).toContain("document.querySelector('#root')");
  expect(source).toContain("setAttribute('inert', '')");
  expect(source).toMatch(/createPortal\([\s\S]*document\.body/);
  expect(source).toMatch(/aria-disabled=\{saving\}/);
  const cancelButton = source.match(/<button ref=\{cancelRef\}[^>]*>/)?.[0] || '';
  expect(cancelButton).not.toContain('disabled={saving}');
});

test('InitiativeDetail implements one keyboard-operable tablist and labelled panel for every tab', () => {
  const source = fs.readFileSync(path.join(__dirname, 'InitiativeDetail.js'), 'utf8');

  expect(source).toContain('role="tablist"');
  expect(source).toContain('role="tab"');
  expect(source).toContain('role="tabpanel"');
  expect(source).toContain('aria-selected={tab === t}');
  expect(source).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End']");
  expect(source).toContain('tabIndex={tab === t ? 0 : -1}');
  expect(source).toContain('aria-labelledby={`initiative-tab-${tabId(tab)}`}');
});
