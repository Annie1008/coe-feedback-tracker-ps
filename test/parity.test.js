const assert = require('node:assert/strict');
const test = require('node:test');
const { compareProjectedData } = require('../scripts/check-field-input-parity');

const feedback = { id: 'f1', providerName: 'Ada', providerRole: 'VP', region: 'Global', date: '2026-01-01', notes: 'N', actionItems: [{ id: 'a1', text: 'A', done: false }] };

test('parity compares normalized feedback, actions, closed loops, extras, and duplicates', () => {
  assert.equal(compareProjectedData({ feedback: [feedback], closedLoop: { f1: { closed: false } } }, { feedback: [feedback], closedLoop: { f1: { closed: false } } }).ok, true);
  for (const canonical of [
    { feedback: [{ ...feedback, notes: 'changed' }], closedLoop: { f1: { closed: false } } },
    { feedback: [feedback, { ...feedback }], closedLoop: { f1: { closed: false } } },
    { feedback: [feedback, { ...feedback, id: 'extra' }], closedLoop: { f1: { closed: false } } },
    { feedback: [{ ...feedback, actionItems: [] }], closedLoop: { f1: { closed: false } } },
    { feedback: [feedback], closedLoop: { f1: { closed: true } } }
  ]) assert.equal(compareProjectedData({ feedback: [feedback], closedLoop: { f1: { closed: false } } }, canonical).ok, false);
});

test('parity ignores native canonical rows but reports imported relationship violations', () => {
  const native = { ...feedback, id: 'native', legacyFeedbackId: null };
  assert.equal(compareProjectedData(
    { feedback: [feedback], closedLoop: { f1: { closed: false } } },
    { feedback: [feedback, native], closedLoop: { f1: { closed: false } } }
  ).ok, true);
  const broken = { ...feedback, relationshipError: 'submission parent is retired' };
  const report = compareProjectedData({ feedback: [feedback] }, { feedback: [broken] });
  assert.equal(report.ok, false);
  assert.deepEqual(report.relationshipErrors, [{ id: 'f1', error: 'submission parent is retired' }]);
});

test('parity includes initiative mutable fields and OU enablement, including initiatives without feedback', () => {
  const legacy = { initiatives: [{ id: 'i1', name: 'One', description: 'D', rolloutDate: '2026-01-01', color: '#fff', ouEnablement: { Global: { enabled: true, format: 'Webinar' } } }], feedback: [] };
  const same = { initiatives: structuredClone(legacy.initiatives), feedback: [] };
  assert.equal(compareProjectedData(legacy, same).ok, true);
  same.initiatives[0].ouEnablement.Global.format = 'Slack';
  assert.equal(compareProjectedData(legacy, same).ok, false);
  assert.equal(compareProjectedData(legacy, { initiatives: [], feedback: [] }).ok, false);
});

test('parity rejects extra legacy-imported initiatives but ignores native initiatives', () => {
  const legacy = { initiatives: [{ id: 'legacy', name: 'Legacy' }], feedback: [] };
  const expected = { id: 'legacy', name: 'Legacy', legacyImported: true };
  const native = { id: 'native', name: 'Native', legacyImported: false };
  assert.equal(compareProjectedData(legacy, { initiatives: [expected, native], feedback: [] }).ok, true);

  const report = compareProjectedData(legacy, { initiatives: [expected, native, {
    id: 'stale', name: 'Stale', legacyImported: true
  }], feedback: [] });
  assert.equal(report.ok, false);
  assert.deepEqual(report.extraInitiativeIds, ['stale']);
});

test('parity treats pg Date values as date-only and equivalent ISO instant spellings as equal', () => {
  const legacy = { initiatives: [{ id: 'i1', name: 'One', rolloutDate: '2026-02-04' }], feedback: [{
    ...feedback,
    date: '2026-02-28',
    actionItems: [{ id: 'a1', text: 'A', done: false, createdAt: '2026-02-28T12:34:56.590Z' }]
  }] };
  const canonical = { initiatives: [{ id: 'i1', name: 'One', rolloutDate: new Date(2026, 1, 4) }], feedback: [{
    ...feedback,
    date: new Date(2026, 1, 28),
    actionItems: [{ id: 'a1', text: 'A', done: false, createdAt: '2026-02-28T12:34:56.59+00:00' }]
  }] };
  assert.equal(compareProjectedData(legacy, canonical).ok, true);
});
