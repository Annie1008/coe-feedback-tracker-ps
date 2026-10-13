const assert = require('node:assert/strict');
const test = require('node:test');
const {
  extractFinalJsonValue, normalizeAssistItem, assistMergeGroups, buildMergeAssistPrompt, clipCanonicalText
} = require('../src/mergeAssist');

test('normalizeAssistItem rejects unknown winners and adjacent-need suggestions', () => {
  const group = { members: [{ id: 'a' }, { id: 'b' }] };
  assert.deepEqual(normalizeAssistItem({ verdict: 'same_need', suggestedWinnerId: 'b', confidence: 1.4, reason: 'same' }, group),
    { verdict: 'same_need', suggestedWinnerId: 'b', confidence: 1, reason: 'same' });
  assert.equal(normalizeAssistItem({ verdict: 'adjacent_need', suggestedWinnerId: 'a', confidence: 0.9, reason: 'related' }, group).suggestedWinnerId, null);
  assert.deepEqual(normalizeAssistItem({ verdict: 'same_need', suggestedWinnerId: 'missing', confidence: 'x' }, group),
    { verdict: 'same_need', suggestedWinnerId: null, confidence: 0, reason: '' });
});

test('extractFinalJsonValue returns the last JSON value and ignores fences', () => {
  assert.deepEqual(extractFinalJsonValue('noise [{"groupIndex":0}] ```json [{"groupIndex":1,"verdict":"same_need"}] ```'),
    [{ groupIndex: 1, verdict: 'same_need' }]);
});

test('assistMergeGroups never auto-merges and maps results by group id', async () => {
  const groups = [
    { id: 'g1', members: [{ id: 'a', text: 'retry after timeout' }, { id: 'b', text: 'resume after timeout' }] },
    { id: 'g2', members: [{ id: 'c', text: 'csv export' }, { id: 'd', text: 'org62 writeback' }] }
  ];
  const result = await assistMergeGroups(groups, { callAI: async () => JSON.stringify([
    { groupIndex: 0, verdict: 'same_need', suggestedWinnerId: 'b', confidence: 0.8, reason: 'same retry need' },
    { groupIndex: 1, verdict: 'adjacent_need', suggestedWinnerId: 'c', confidence: 0.7, reason: 'different outcomes' }
  ]) });
  assert.deepEqual(result.g1, { verdict: 'same_need', suggestedWinnerId: 'b', confidence: 0.8, reason: 'same retry need' });
  assert.equal(result.g2.verdict, 'adjacent_need');
  assert.equal(result.g2.suggestedWinnerId, null);
});

test('assistMergeGroups falls back per batch when the model fails', async () => {
  const result = await assistMergeGroups([{ id: 'g1', members: [{ id: 'a', text: 'one' }] }], {
    callAI: async () => { throw new Error('NO_KEY'); }
  });
  assert.deepEqual(result.g1, { verdict: 'adjacent_need', suggestedWinnerId: null, confidence: 0, reason: '', error: 'NO_KEY' });
});

test('prompt asks for same vs adjacent need and forbids invented ids', () => {
  const prompt = buildMergeAssistPrompt([{ id: 'g1', members: [{ id: 'a', text: 'x'.repeat(1200), submissionCount: 3 }] }]);
  assert.match(prompt, /same_need/);
  assert.match(prompt, /adjacent_need/);
  assert.match(prompt, /Never invent member ids/);
  assert.equal(clipCanonicalText('x'.repeat(1200)).endsWith('…'), true);
  assert.equal(prompt.includes('x'.repeat(900)), false);
});

test('Merge Review UI keeps lexical generation and never auto-confirms AI suggestions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const review = fs.readFileSync(path.join(__dirname, '../src/components/CanonicalMergeReview.js'), 'utf8');
  const detail = fs.readFileSync(path.join(__dirname, '../src/components/InitiativeDetail.js'), 'utf8');
  assert.match(detail, /'Feedback Analysis', 'Merge Review'/);
  assert.match(review, /assistMergeGroups/);
  assert.match(review, /AI never merges automatically/);
  assert.match(review, /await generateCandidates[\s\S]*assistMergeGroups/);
  assert.doesNotMatch(review, /await confirmGroup\([\s\S]*assistMergeGroups/);
  assert.match(review, /onClick=\{\(\) => load\(\)\}/);
});
