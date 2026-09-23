const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createCanonicalApiHandler } = require('../server/canonicalApi');

function request(method, url, body, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  req.headers.host ||= 'localhost';
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function response() {
  let resolve;
  const done = new Promise(r => { resolve = r; });
  return {
    statusCode: null, headers: {}, body: '', done,
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; Object.assign(this.headers, headers); },
    end(chunk = '') { this.body += chunk; resolve(); }
  };
}

async function invoke(handler, method, url, body, headers) {
  const req = request(method, url, body, headers);
  const res = response();
  assert.equal(await handler(req, res), true);
  await res.done;
  return { status: res.statusCode, json: JSON.parse(res.body), headers: res.headers };
}

function scriptedPool(steps) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      const step = steps.shift();
      if (!step) throw new Error(`unexpected query: ${sql}`);
      if (step.match) assert.match(String(sql), step.match);
      if (step.error) throw step.error;
      return typeof step.result === 'function' ? step.result(sql, params) : (step.result || { rows: [], rowCount: 0 });
    },
    release() { queries.push({ sql: 'RELEASE', params: [] }); }
  };
  return { pool: { async connect() { return client; }, query: client.query.bind(client) }, queries };
}

test('list bounds limit, uses stable cursor SQL, and omits raw legacy', async () => {
  const { pool, queries } = scriptedPool([{ match: /ORDER BY cf\.created_at DESC, cf\.id DESC/, result: { rows: [{
    id: 'f1', title: 'Title', canonical_text: 'Text', version: 1, initiative_id: 'i1', initiative_name: 'Initiative',
    created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', closed: false,
    submission_count: '1', status_updated_at: '2026-01-04T00:00:00.000Z', raw_legacy: { secret: true }
  }] } }]);
  const handler = createCanonicalApiHandler({ pool });
  const cursor = Buffer.from(JSON.stringify({ createdAt: '2026-01-03T00:00:00.000Z', id: 'f2' })).toString('base64url');

  const result = await invoke(handler, 'GET', `/api/canonical/feedback?limit=999&initiativeId=i1&cursor=${cursor}`);

  assert.equal(result.status, 200);
  assert.equal(queries[0].params.at(-1), 101);
  assert.match(queries[0].sql, /\(cf\.created_at, cf\.id\) < \(/);
  assert.deepEqual(result.json.items[0], {
    id: 'f1', title: 'Title', text: 'Text', version: 1, initiative: { id: 'i1', name: 'Initiative' },
    createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', closed: false,
    statusUpdatedAt: '2026-01-04T00:00:00.000Z', submissionCount: 1
  });
  assert.doesNotMatch(queries[0].sql, /jsonb_agg|provider_snapshot/i);
  assert.equal(JSON.stringify(result.json).includes('raw_legacy'), false);
});

test('detail allowlists source data and returns null when a submission has no closed loop', async () => {
  const { pool } = scriptedPool([
    { match: /FROM canonical_feedback cf/, result: { rows: [{ id: 'f1', title: null, canonical_text: 'Text', version: 1, initiative_id: null, initiative_name: null, created_at: 'now', updated_at: 'now', status_updated_at: 'later', closed: false }] } },
    { match: /FROM feedback_submissions fs/, result: { rows: [{ id: 's1', provider_snapshot: { name: 'P' }, source_data: { sourceType: 'form', sourceName: 'survey', externalId: 'x', secret: true }, submitted_on: '2026-01-01', version: 7, closed_loop_id: null, raw_legacy: { no: true } }] } }
  ]);

  const result = await invoke(createCanonicalApiHandler({ pool }), 'GET', '/api/canonical/feedback/f1');

  assert.equal(result.status, 200);
  assert.equal(result.json.statusUpdatedAt, 'later');
  assert.equal(result.json.submissions[0].closedLoop, null);
  assert.deepEqual(result.json.submissions[0].sourceData, { sourceType: 'form', sourceName: 'survey', externalId: 'x' });
  assert.equal(JSON.stringify(result.json).includes('raw_legacy'), false);
});

test('native create commits canonical and submission then stores idempotent response', async () => {
  const { pool, queries } = scriptedPool([
    { match: /BEGIN/ }, { match: /SET LOCAL lock_timeout/ }, { match: /SET LOCAL statement_timeout/ },
    { match: /DELETE FROM api_idempotency.*expires_at/s }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: null, response: null }] } },
    { match: /INSERT INTO canonical_feedback/ }, { match: /canonical_feedback.*FOR UPDATE/s, result: { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] } }, { match: /INSERT INTO feedback_submissions/ },
    { match: /UPDATE api_idempotency/, result: { rowCount: 1, rows: [] } }, { match: /COMMIT/ }
  ]);
  const body = { id: '11111111-1111-4111-8111-111111111111', submissionId: '22222222-2222-4222-8222-222222222222', provider: { name: ' Ada ', role: 'Architect', region: 'EMEA' }, canonicalText: ' Useful ', date: '2026-02-28', sourceCreatedAt: '2026-02-28T12:00:00Z', sourceData: { sourceType: 'form', externalId: '42' } };

  const result = await invoke(createCanonicalApiHandler({ pool }), 'POST', '/api/canonical/feedback', body, { 'Idempotency-Key': 'create-key-000001' });

  assert.equal(result.status, 201);
  assert.equal(result.json.id, body.id);
  assert.doesNotMatch(queries.find(query => /INSERT INTO canonical_feedback/.test(query.sql)).sql, /created_at/);
  assert.ok(queries.some(query => /legacy_snapshot_id/.test(query.sql) === false && /INSERT INTO feedback_submissions/.test(query.sql)));
  assert.ok(queries.some(query => query.sql === 'COMMIT'));
  const submission = queries.find(query => /INSERT INTO feedback_submissions/.test(query.sql));
  assert.deepEqual(submission.params[3], { name: 'Ada', role: 'Architect', region: 'EMEA' });
  assert.equal(submission.params[6], body.sourceCreatedAt);
});

test('native create retries stored response and conflicts for changed body', async () => {
  const body = { provider: { name: 'Ada' }, canonicalText: 'Useful' };
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const stored = { id: 'f1', submissionId: 's1' };
  const retryPool = scriptedPool([{ match: /BEGIN/ }, { match: /SET LOCAL lock_timeout/ }, { match: /SET LOCAL statement_timeout/ }, { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: hash, response: stored }] } }, { match: /COMMIT/ }]).pool;
  const retry = await invoke(createCanonicalApiHandler({ pool: retryPool }), 'POST', '/api/canonical/feedback', body, { 'Idempotency-Key': 'same-key-0000001' });
  assert.deepEqual(retry, { status: 201, json: stored, headers: { 'Content-Type': 'application/json' } });

  const conflictPool = scriptedPool([{ match: /BEGIN/ }, { match: /SET LOCAL lock_timeout/ }, { match: /SET LOCAL statement_timeout/ }, { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: 'different', response: stored }] } }, { match: /ROLLBACK/ }]).pool;
  const conflict = await invoke(createCanonicalApiHandler({ pool: conflictPool }), 'POST', '/api/canonical/feedback', body, { 'Idempotency-Key': 'same-key-0000001' });
  assert.equal(conflict.status, 409);
});

test('native create verifies initiative and rolls back missing initiative or insert failure', async () => {
  for (const tail of [
    [{ match: /FROM initiatives.*FOR UPDATE/s, result: { rows: [] } }, { match: /ROLLBACK/ }],
    [{ match: /INSERT INTO canonical_feedback/, error: new Error('db broke') }, { match: /ROLLBACK/ }]
  ]) {
    const steps = [{ match: /BEGIN/ }, { match: /SET LOCAL lock_timeout/ }, { match: /SET LOCAL statement_timeout/ }, { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: null }] } }, ...tail];
    const { pool, queries } = scriptedPool(steps);
    const result = await invoke(createCanonicalApiHandler({ pool }), 'POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T', ...(tail[0].match.source.includes('initiatives') ? { initiativeId: 'missing' } : {}) }, { 'Idempotency-Key': 'valid-key-000001' });
    assert.ok([404, 500].includes(result.status));
    assert.ok(queries.some(query => query.sql === 'ROLLBACK'));
    assert.equal(result.json.error.includes('db broke'), false);
  }
});

test('closed-loop PATCH locks canonical first and derives all-closed status across two submissions', async () => {
  const { pool, queries } = scriptedPool([
    { match: /BEGIN/ }, { match: /SET LOCAL lock_timeout/ }, { match: /SET LOCAL statement_timeout/ },
    { match: /FROM canonical_feedback cf.*JOIN feedback_submissions.*FOR UPDATE OF cf/s, result: { rows: [{ canonical_feedback_id: 'f1' }] } },
    { match: /FROM feedback_submissions fs/, result: { rows: [{ submission_id: 's1', canonical_feedback_id: 'f1', loop_id: null, loop_version: null }] } },
    { match: /INSERT INTO closed_loops/, result: { rows: [{ closed_loop_id: 'loop:s1', how_incorporated: '', communicated_back: 'Pending', communication_method: '', closed_date: null, closed: true, notes: '', closed_loop_version: 1 }] } },
    { match: /NOT EXISTS/, result: { rows: [{ closed: false }] } }, { match: /COMMIT/ }
  ]);

  const result = await invoke(createCanonicalApiHandler({ pool }), 'PATCH', '/api/canonical/submissions/s1/closed-loop', { expectedVersion: 0, closed: true });
  assert.equal(result.status, 200);
  assert.equal(result.json.canonicalClosed, false);
  assert.equal(result.json.closedLoop.id, 'loop:s1');
  assert.ok(queries.findIndex(q => /FOR UPDATE OF cf/.test(q.sql)) < queries.findIndex(q => /FROM feedback_submissions fs/.test(q.sql)));
});

test('closed-loop PATCH preserves omitted values and normalizes communicatedBack booleans', async () => {
  const { pool, queries } = scriptedPool([
    { match: /BEGIN/ }, { match: /SET LOCAL lock_timeout/ }, { match: /SET LOCAL statement_timeout/ },
    { match: /FROM canonical_feedback cf.*JOIN feedback_submissions.*FOR UPDATE OF cf/s, result: { rows: [{ canonical_feedback_id: 'f1' }] } },
    { match: /FROM feedback_submissions fs/, result: { rows: [{ submission_id: 's1', canonical_feedback_id: 'f1', loop_id: 'l1', loop_version: 2, how_incorporated: 'keep', communicated_back: 'Pending', communication_method: 'Email', closed_date: '2026-01-01', closed: true, notes: 'keep notes' }] } },
    { match: /UPDATE closed_loops/, result: { rows: [{ closed_loop_id: 'l1', closed: true, closed_loop_version: 3, how_incorporated: 'keep', communicated_back: 'Yes', communication_method: 'Email', closed_date: '2026-01-01', notes: 'keep notes' }] } },
    { match: /NOT EXISTS/, result: { rows: [{ closed: false }] } }, { match: /COMMIT/ }
  ]);
  const result = await invoke(createCanonicalApiHandler({ pool }), 'PATCH', '/api/canonical/submissions/s1/closed-loop', { expectedVersion: 2, communicatedBack: true });
  assert.equal(result.status, 200);
  assert.deepEqual(queries.find(q => /UPDATE closed_loops/.test(q.sql)).params.slice(1, 7), ['keep', 'Yes', 'Email', '2026-01-01', true, 'keep notes']);
});

test('attaches an idempotent submission with canonical-scoped operation and parent lock', async () => {
  const body = { submissionId: '22222222-2222-4222-8222-222222222222', provider: { name: 'Ada', role: 'Architect', region: 'EMEA' }, date: '2026-02-28', sourceCreatedAt: '2026-02-28T12:00:00Z', sourceData: { sourceName: 'survey' } };
  const { pool, queries } = scriptedPool([
    { match: /BEGIN/ }, { match: /SET LOCAL lock_timeout/ }, { match: /SET LOCAL statement_timeout/ },
    { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: null, response: null }] } },
    { match: /FROM canonical_feedback.*FOR UPDATE/s, result: { rows: [{ id: 'f1', initiative_id: 'i1' }] } },
    { match: /INSERT INTO feedback_submissions/ }, { match: /UPDATE api_idempotency/ }, { match: /COMMIT/ }
  ]);
  const result = await invoke(createCanonicalApiHandler({ pool }), 'POST', '/api/canonical/feedback/f1/submissions', body, { 'Idempotency-Key': 'attach-key-000001' });
  assert.equal(result.status, 201);
  assert.deepEqual(result.json, { id: body.submissionId, canonicalFeedbackId: 'f1', canonicalClosed: false });
  const reservation = queries.find(q => /INSERT INTO api_idempotency/.test(q.sql));
  assert.match(reservation.params[0], /attach-submission:f1/);
  assert.ok(queries.findIndex(q => /FROM canonical_feedback/.test(q.sql)) < queries.findIndex(q => /INSERT INTO feedback_submissions/.test(q.sql)));
  assert.equal(queries.find(q => /INSERT INTO feedback_submissions/.test(q.sql)).params[2], 'i1');
});

test('attach submission replays the same key and body and conflicts when the body changes', async () => {
  const body = { provider: { name: 'Ada' } };
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const stored = { id: 's1', canonicalFeedbackId: 'f1', canonicalClosed: false };
  const prefix = [{ match: /BEGIN/ }, { match: /SET LOCAL lock_timeout/ }, { match: /SET LOCAL statement_timeout/ }, { match: /DELETE FROM api_idempotency/ }];
  const replayPool = scriptedPool([...prefix, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: hash, response: stored }] } }, { match: /COMMIT/ }]).pool;
  const replay = await invoke(createCanonicalApiHandler({ pool: replayPool }), 'POST', '/api/canonical/feedback/f1/submissions', body, { 'Idempotency-Key': 'attach-key-000001' });
  assert.deepEqual(replay.json, stored);

  const conflictPool = scriptedPool([...prefix, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: 'different', response: stored }] } }, { match: /ROLLBACK/ }]).pool;
  const conflict = await invoke(createCanonicalApiHandler({ pool: conflictPool }), 'POST', '/api/canonical/feedback/f1/submissions', body, { 'Idempotency-Key': 'attach-key-000001' });
  assert.equal(conflict.status, 409);
});

test('canonical input boundaries reject invalid values before database access', async () => {
  const pool = { async query() { throw new Error('unused'); }, async connect() { throw new Error('unused'); } };
  const handler = createCanonicalApiHandler({ pool, appOrigin: 'https://trusted.example' });
  const cases = [
    ['POST', '/api/canonical/feedback', null, { 'Idempotency-Key': 'valid-key-000001' }],
    ['POST', '/api/canonical/feedback', { provider: { name: 'P', role: 2 }, canonicalText: 'T' }, { 'Idempotency-Key': 'valid-key-000001' }],
    ['POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T', date: '2026-02-30' }, { 'Idempotency-Key': 'valid-key-000001' }],
    ['POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T', sourceCreatedAt: 'today' }, { 'Idempotency-Key': 'valid-key-000001' }],
    ['POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T', sourceData: { secret: 'no' } }, { 'Idempotency-Key': 'valid-key-000001' }],
    ['PATCH', '/api/canonical/submissions/s1/closed-loop', { expectedVersion: 0, communicatedBack: 'Maybe' }],
    ['PATCH', '/api/canonical/submissions/s1/closed-loop', { expectedVersion: 0, closed: 'yes' }],
    ['PATCH', '/api/canonical/submissions/s1/closed-loop', { expectedVersion: 0, closedDate: '2025-02-29' }],
    ['GET', '/api/canonical/feedback/%E0%A4%A'],
    ['POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T' }, { 'Idempotency-Key': 'short' }],
    ['POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T' }, { 'Idempotency-Key': 'invalid key spaces' }],
    ['POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T' }, { 'Idempotency-Key': 'valid-key-000001', Origin: 'https://evil.example' }]
  ];
  for (const [method, url, body, headers] of cases) assert.equal((await invoke(handler, method, url, body, headers)).status, 400, `${method} ${url}`);
});

test('canonical origin policy permits no-Origin, configured origin, and same-host origin', async () => {
  const pool = { async query() { return { rows: [] }; }, async connect() { throw new Error('unused'); } };
  const handler = createCanonicalApiHandler({ pool, appOrigin: 'https://trusted.example' });
  assert.equal((await invoke(handler, 'GET', '/api/canonical/feedback')).status, 200);
  assert.equal((await invoke(handler, 'GET', '/api/canonical/feedback', undefined, { Origin: 'https://trusted.example' })).status, 200);
  assert.equal((await invoke(handler, 'GET', '/api/canonical/feedback', undefined, { Origin: 'http://localhost', Host: 'localhost' })).status, 200);
});

test('canonical routes validate methods, bodies, limits, IDs, availability, and body cap', async () => {
  const noDb = createCanonicalApiHandler({ pool: null });
  assert.equal((await invoke(noDb, 'GET', '/api/canonical/feedback')).status, 503);
  const pool = { async query() { return { rows: [] }; }, async connect() { throw new Error('unused'); } };
  const handler = createCanonicalApiHandler({ pool });
  assert.equal((await invoke(handler, 'DELETE', '/api/canonical/feedback')).status, 405);
  assert.equal((await invoke(handler, 'GET', '/api/canonical/feedback?limit=bad')).status, 400);
  assert.equal((await invoke(handler, 'POST', '/api/canonical/feedback', { provider: { name: ' ' }, canonicalText: '' }, { 'Idempotency-Key': 'valid-key-000001' })).status, 400);
  assert.equal((await invoke(handler, 'POST', '/api/canonical/feedback', { id: 'bad', provider: { name: 'P' }, canonicalText: 'T' }, { 'Idempotency-Key': 'valid-key-000001' })).status, 400);
  assert.equal((await invoke(handler, 'POST', '/api/canonical/feedback', 'x'.repeat(1024 * 1024 + 1), { 'Idempotency-Key': 'valid-key-000001' })).status, 413);
  assert.equal((await invoke(handler, 'PUT', '/api/canonical/submissions/s1/closed-loop', { expectedVersion: 0 })).status, 405);
});
