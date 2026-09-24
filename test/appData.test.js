const assert = require('node:assert/strict');
const test = require('node:test');

const { mergeApprovedSidecars, validateAppDataWrite } = require('../server/appData');
const fs = require('node:fs');
const path = require('node:path');

test('app_data writes preserve canonical shadow keys and merge approved new sidecars', () => {
  const current = { feedback: [{ id: 'old' }], closedLoop: { old: { closed: true } }, initiatives: [{ id: 'i1' }], providerEmails: { Ada: 'old@example.com' }, peopleEmails: { Ada: 'a@example.com' }, slackChannelId: 'C1', secret: 'keep-out' };
  const incoming = { feedback: [{ id: 'resurrected' }], closedLoop: {}, initiatives: [{ id: 'overwrite' }], providerEmails: { Grace: 'g@example.com' }, peopleEmails: { Grace: 'grace@example.com' }, slackChannelId: 'C2', arbitrary: 'reject' };
  const result = mergeApprovedSidecars(current, incoming);
  assert.deepEqual(result.feedback, current.feedback);
  assert.deepEqual(result.closedLoop, current.closedLoop);
  assert.deepEqual(result.providerEmails, { Ada: 'old@example.com', Grace: 'g@example.com' });
  assert.deepEqual(result.peopleEmails, { Ada: 'a@example.com', Grace: 'grace@example.com' });
  assert.equal(result.slackChannelId, 'C2');
  assert.equal(result.arbitrary, undefined);
  assert.equal(result.secret, undefined);
  assert.deepEqual(result.initiatives, current.initiatives);
});

test('app_data rejects canonical keys, oversized bodies, missing Origin, and cross-origin writes', () => {
  assert.throws(() => validateAppDataWrite({ feedback: [] }, { origin: 'https://app.example', host: 'app.example' }, 'https://app.example'), /canonical Field Inputs/i);
  assert.throws(() => validateAppDataWrite({ initiatives: [] }, { origin: 'https://app.example', host: 'app.example' }, 'https://app.example'), /canonical Field Inputs/i);
  assert.throws(() => validateAppDataWrite({}, { host: 'app.example' }, 'https://app.example'), /Origin header is required/);
  assert.throws(() => validateAppDataWrite({}, { origin: 'https://evil.example', host: 'app.example' }, 'https://app.example'), /Untrusted Origin/);
  assert.throws(() => validateAppDataWrite({}, { origin: 'https://app.example', host: 'app.example' }, 'https://app.example', 1024 * 1024 + 1), /too large/);
});

test('production origin policy requires configured APP_ORIGIN and never trusts Host', () => {
  assert.throws(() => validateAppDataWrite({}, { origin: 'https://app.example', host: 'app.example' }, '', 2, { production: true }), /APP_ORIGIN/);
  assert.throws(() => validateAppDataWrite({}, { origin: 'https://spoof.example', host: 'spoof.example' }, 'https://app.example', 2, { production: true }), /Untrusted Origin/);
  assert.doesNotThrow(() => validateAppDataWrite({}, { origin: 'https://app.example' }, 'https://app.example/', 2, { production: true }));
});

test('development origin policy permits configured origin or localhost only', () => {
  assert.doesNotThrow(() => validateAppDataWrite({}, { origin: 'http://localhost:3000' }, '', 2, { production: false }));
  assert.throws(() => validateAppDataWrite({}, { origin: 'https://preview.example', host: 'preview.example' }, '', 2, { production: false }), /Untrusted Origin/);
});

test('timeline history is merged by id so concurrent entries survive', () => {
  const result = mergeApprovedSidecars(
    { timelineHistory: [{ id: 'first', month: 'Sep' }] },
    { timelineHistory: [{ id: 'second', month: 'Oct' }, { id: 'first', month: 'Nov' }] }
  );
  assert.deepEqual(result.timelineHistory, [
    { id: 'first', month: 'Nov' },
    { id: 'second', month: 'Oct' }
  ]);
});

test('/api/data takes the cutover advisory lock in its write transaction and sanitizes unexpected errors', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const route = source.slice(source.indexOf("if (pathname === '/api/data')"), source.indexOf('// ── AI feedback-dedup cache'));
  assert.match(route, /BEGIN[\s\S]*pg_advisory_xact_lock[\s\S]*readCutoverState[\s\S]*INSERT INTO app_data/);
  assert.match(route, /e\.status \? e\.message : 'Internal server error'/);
});
