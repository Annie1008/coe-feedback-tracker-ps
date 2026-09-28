import { normalizeData, sidecarsOnly, cutoverIsWritable, canonicalEmergencyReadOnly } from './data';

test('sidecar saves always exclude canonical keys and initiatives', () => {
  const result = sidecarsOnly({ feedback: [{ id: 'x' }], closedLoop: { x: {} }, initiatives: [{ id: 'i1' }], peopleEmails: { Ada: 'a@example.com' }, slackChannelId: 'C1' });
  expect(result.feedback).toBeUndefined();
  expect(result.closedLoop).toBeUndefined();
  expect(result.initiatives).toBeUndefined();
  expect(result.peopleEmails).toEqual({ Ada: 'a@example.com' });
  expect(result.slackChannelId).toBe('C1');
});

test('canonical cache retains complete UI state while network payload strips canonical keys', () => {
  const full = normalizeData({ initiatives: [], feedback: null, closedLoop: [] });
  expect(full.feedback).toEqual([]);
  expect(full.closedLoop).toEqual({});
  expect(sidecarsOnly({ ...full, feedback: [{ id: 'x' }], closedLoop: { x: {} } })).not.toHaveProperty('feedback');
});

test('runtime server stage controls writes while build flag is emergency read-only only', () => {
  expect(cutoverIsWritable({ stage: 'canonical_active' }, {})).toBe(true);
  expect(cutoverIsWritable({ stage: 'legacy_read_only' }, {})).toBe(false);
  expect(canonicalEmergencyReadOnly({ REACT_APP_CANONICAL_FIELD_INPUTS: 'false' })).toBe(true);
  expect(cutoverIsWritable({ stage: 'canonical_active' }, { REACT_APP_CANONICAL_FIELD_INPUTS: 'false' })).toBe(false);
  expect(cutoverIsWritable({ stage: 'canonical_active' }, {}, 'load failed')).toBe(false);
});
