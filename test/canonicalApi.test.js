const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createCanonicalApiHandler } = require('../server/canonicalApi');

const REVIEW_TOKEN = 'review-secret-token';
const REVIEW_HEADERS = { 'x-merge-review-token': REVIEW_TOKEN };

function handlerFor(pool, options = {}) {
  return createCanonicalApiHandler({ pool, mergeReviewToken: REVIEW_TOKEN, ...options });
}

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

test('detail allowlists source data, returns original evidence, and returns null when a submission has no closed loop', async () => {
  const { pool } = scriptedPool([
    { match: /canonical_feedback_aliases/, result: { rows: [{ resolved_id: 'f1', resolved_from: null }] } },
    { match: /FROM canonical_feedback cf/, result: { rows: [{ id: 'f1', title: null, canonical_text: 'Text', version: 1, initiative_id: null, initiative_name: null, created_at: 'now', updated_at: 'now', status_updated_at: 'later', closed: false }] } },
    { match: /FROM feedback_submissions fs/, result: { rows: [{ id: 's1', original_text: 'Original evidence', provider_snapshot: { name: 'P' }, source_data: { sourceType: 'form', sourceName: 'survey', externalId: 'x', secret: true }, submitted_on: '2026-01-01', version: 7, closed_loop_id: null, raw_legacy: { no: true } }] } }
  ]);

  const result = await invoke(createCanonicalApiHandler({ pool }), 'GET', '/api/canonical/feedback/f1');

  assert.equal(result.status, 200);
  assert.equal(result.json.statusUpdatedAt, 'later');
  assert.equal(result.json.submissions[0].closedLoop, null);
  assert.equal(result.json.submissions[0].originalText, 'Original evidence');
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
  const body = { id: '11111111-1111-4111-8111-111111111111', submissionId: '22222222-2222-4222-8222-222222222222', provider: { name: ' Ada ', role: 'Architect', region: 'EMEA' }, canonicalText: ' Useful ', originalText: ' Provider words ', date: '2026-02-28', sourceCreatedAt: '2026-02-28T12:00:00Z', sourceData: { sourceType: 'form', externalId: '42' } };

  const result = await invoke(createCanonicalApiHandler({ pool }), 'POST', '/api/canonical/feedback', body, { 'Idempotency-Key': 'create-key-000001' });

  assert.equal(result.status, 201);
  assert.equal(result.json.id, body.id);
  assert.doesNotMatch(queries.find(query => /INSERT INTO canonical_feedback/.test(query.sql)).sql, /created_at/);
  assert.ok(queries.some(query => /legacy_snapshot_id/.test(query.sql) === false && /INSERT INTO feedback_submissions/.test(query.sql)));
  assert.ok(queries.some(query => query.sql === 'COMMIT'));
  const submission = queries.find(query => /INSERT INTO feedback_submissions/.test(query.sql));
  assert.deepEqual(submission.params[3], { name: 'Ada', role: 'Architect', region: 'EMEA' });
  assert.equal(submission.params[6], body.sourceCreatedAt);
  assert.equal(submission.params[7], 'Provider words');
});

test('native create retries stored response and conflicts for changed body', async () => {
  const body = { provider: { name: 'Ada' }, canonicalText: 'Useful', originalText: 'Provider words' };
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
    const result = await invoke(createCanonicalApiHandler({ pool }), 'POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T', originalText: 'O', ...(tail[0].match.source.includes('initiatives') ? { initiativeId: 'missing' } : {}) }, { 'Idempotency-Key': 'valid-key-000001' });
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
  const body = { submissionId: '22222222-2222-4222-8222-222222222222', provider: { name: 'Ada', role: 'Architect', region: 'EMEA' }, originalText: 'Provider words', date: '2026-02-28', sourceCreatedAt: '2026-02-28T12:00:00Z', sourceData: { sourceName: 'survey' } };
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
  assert.equal(queries.find(q => /INSERT INTO feedback_submissions/.test(q.sql)).params[7], 'Provider words');
});

test('attach submission replays the same key and body and conflicts when the body changes', async () => {
  const body = { provider: { name: 'Ada' }, originalText: 'Provider words' };
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

test('candidate generation is idempotent, initiative-scoped, unordered, active-only, and preserves decisions', async () => {
  const { pool, queries } = scriptedPool([
    { match: /BEGIN/ }, { match: /lock_timeout/ }, { match: /statement_timeout.*30s/ },
    { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: null, response: null }] } },
    { match: /FROM initiatives.*FOR UPDATE/s, result: { rows: [{ id: 'i1' }] } },
    { match: /COUNT\(\*\).*canonical_feedback/s, result: { rows: [{ active_count: '3' }] } },
    { match: /INSERT INTO duplicate_candidates[\s\S]*similarity[\s\S]*ON CONFLICT \(pair_low, pair_high\)[\s\S]*WHERE duplicate_candidates\.status = 'pending'/, result: { rows: [{ inserted: true }, { inserted: false }] } },
    { match: /UPDATE api_idempotency/ }, { match: /COMMIT/ }
  ]);
  const result = await invoke(handlerFor(pool), 'POST', '/api/canonical/duplicate-candidates/generate',
    { initiativeId: 'i1', threshold: 0.5, limitPerItem: 4 }, { 'Idempotency-Key': 'generate-key-0001', ...REVIEW_HEADERS });

  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { generated: 1, refreshed: 1 });
  const sql = queries.find(query => /INSERT INTO duplicate_candidates/.test(query.sql)).sql;
  assert.match(sql, /WITH eligible[\s\S]*WHERE initiative_id = \$1 AND merged_into_id IS NULL/);
  assert.match(sql, /left_cf\.id < right_cf\.id/);
  assert.match(sql, /merged_into_id IS NULL/g);
  assert.match(sql, /normalized_text <> ''[\s\S]*length\(normalized_text\) >= 3/);
  assert.match(sql, /row_number\(\)[\s\S]*PARTITION BY endpoint_id/i);
  assert.match(sql, /leftTextHash[\s\S]*rightTextHash/);
  assert.match(sql, /version = duplicate_candidates\.version \+ 1/);
  assert.match(sql, /IS DISTINCT FROM EXCLUDED\.(?:score|evidence)/);
});

test('candidate list requires initiative and returns stable score/id cursor with bounded details', async () => {
  const { pool, queries } = scriptedPool([{ match: /FROM duplicate_candidates dc[\s\S]*ORDER BY dc\.score DESC NULLS LAST, dc\.id DESC/, result: { rows: [{
    id: 'd1', status: 'pending', score: '0.8', evidence: { algorithm: 'pg_trgm' }, version: 2,
    left_id: 'a', left_title: 'A', left_text: 'alpha', left_version: 1, left_submission_count: '2', left_providers: ['P'],
    right_id: 'b', right_title: 'B', right_text: 'beta', right_version: 3, right_submission_count: '1', right_providers: ['Q']
  }] } }]);
  const handler = handlerFor(pool);
  assert.equal((await invoke(handler, 'GET', '/api/canonical/duplicate-candidates', undefined, REVIEW_HEADERS)).status, 400);
  const result = await invoke(handler, 'GET', '/api/canonical/duplicate-candidates?initiativeId=i1&status=pending&limit=20', undefined, REVIEW_HEADERS);
  assert.equal(result.status, 200);
  assert.equal(result.json.items[0].score, 0.8);
  assert.deepEqual(result.json.items[0].left.providers, ['P']);
  assert.match(queries[0].sql, /merged_into_id IS NULL/);
  assert.doesNotMatch(JSON.stringify(result.json), /raw_legacy/);
});

test('candidate rejection locks pending version, records fixed review attribution, and replays', async () => {
  const body = { expectedVersion: 2, reason: 'not the same' };
  const { pool, queries } = scriptedPool([
    { match: /BEGIN/ }, { match: /lock_timeout/ }, { match: /statement_timeout/ },
    { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: null, response: null }] } },
    { match: /FROM duplicate_candidates.*FOR UPDATE/s, result: { rows: [{ id: 'd1', status: 'pending', version: 2 }] } },
    { match: /UPDATE duplicate_candidates[\s\S]*status = 'rejected'[\s\S]*version = version \+ 1/, result: { rows: [{ id: 'd1', status: 'rejected', version: 3, decided_at: 'now', decided_by: 'review-token', decision_reason: 'not the same' }] } },
    { match: /UPDATE api_idempotency/ }, { match: /COMMIT/ }
  ]);
  const result = await invoke(handlerFor(pool), 'POST', '/api/canonical/duplicate-candidates/d1/reject', body, { 'Idempotency-Key': 'reject-key-000001', ...REVIEW_HEADERS });
  assert.equal(result.status, 200);
  assert.equal(result.json.version, 3);
  assert.ok(queries.some(query => /FOR UPDATE/.test(query.sql)));

  const hash = require('node:crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const replayPool = scriptedPool([
    { match: /BEGIN/ }, { match: /lock_timeout/ }, { match: /statement_timeout/ }, { match: /DELETE FROM api_idempotency/ },
    { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: hash, response: result.json }] } }, { match: /COMMIT/ }
  ]).pool;
  assert.equal(queries.find(query => /status = 'rejected'/.test(query.sql)).params[1], 'review-token');
  assert.deepEqual((await invoke(handlerFor(replayPool), 'POST', '/api/canonical/duplicate-candidates/d1/reject', body, { 'Idempotency-Key': 'reject-key-000001', ...REVIEW_HEADERS })).json, result.json);
});

test('candidate confirmation locks canonicals in ID order, defers constraints, reparents all children, and audits merge', async () => {
  const body = { winnerId: 'b', loserId: 'a', expectedVersion: 4, expectedWinnerVersion: 3, expectedLoserVersion: 2, reason: 'same history' };
  const { pool, queries } = scriptedPool([
    { match: /BEGIN/ }, { match: /lock_timeout/ }, { match: /statement_timeout/ },
    { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: null, response: null }] } },
    { match: /FROM canonical_feedback[\s\S]*id = ANY[\s\S]*ORDER BY id FOR UPDATE/, result: { rows: [{ id: 'a', initiative_id: 'i1', title: 'A', canonical_text: 'alpha', version: 2, merged_into_id: null }, { id: 'b', initiative_id: 'i1', title: 'B', canonical_text: 'beta', version: 3, merged_into_id: null }] } },
    { match: /FROM duplicate_candidates[\s\S]*FOR UPDATE/, result: { rows: [{ id: 'd1', canonical_feedback_id: 'a', candidate_feedback_id: 'b', status: 'pending', version: 4, score: '0.9', evidence: { leftVersion: 2, rightVersion: 3 } }] } },
    { match: /SET CONSTRAINTS closed_loops_submission_canonical_fk, action_items_submission_canonical_fk DEFERRED/ },
    { match: /UPDATE feedback_submissions SET canonical_feedback_id/, result: { rowCount: 2, rows: [] } },
    { match: /UPDATE action_items SET canonical_feedback_id/, result: { rowCount: 3, rows: [] } },
    { match: /UPDATE closed_loops SET canonical_feedback_id/, result: { rowCount: 1, rows: [] } },
    { match: /UPDATE canonical_feedback[\s\S]*merged_into_id/, result: { rowCount: 1, rows: [] } },
    { match: /UPDATE canonical_feedback SET version = version \+ 1/, result: { rowCount: 1, rows: [] } },
    { match: /INSERT INTO canonical_merge_operations/, result: { rows: [{ id: 'op1' }] } },
    { match: /INSERT INTO canonical_feedback_aliases/ },
    { match: /UPDATE duplicate_candidates[\s\S]*status = 'confirmed'/ },
    { match: /UPDATE duplicate_candidates[\s\S]*status = 'superseded'/ },
    { match: /UPDATE canonical_summaries SET stale = TRUE/ },
    { match: /NOT EXISTS/, result: { rows: [{ closed: true }] } },
    { match: /UPDATE api_idempotency/ }, { match: /COMMIT/ }
  ]);
  const result = await invoke(handlerFor(pool), 'POST', '/api/canonical/duplicate-candidates/d1/confirm', body, { 'Idempotency-Key': 'confirm-key-0001', ...REVIEW_HEADERS });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { candidateId: 'd1', mergeOperationId: 'op1', winnerId: 'b', loserId: 'a', movedSubmissions: 2, movedActionItems: 3, movedClosedLoops: 1, canonicalClosed: true });
  assert.ok(queries.findIndex(q => /ORDER BY id FOR UPDATE/.test(q.sql)) < queries.findIndex(q => /FROM duplicate_candidates/.test(q.sql)));
  assert.ok(queries.some(q => q.sql === 'ROLLBACK') === false);
  assert.match(queries.find(q => /UPDATE feedback_submissions/.test(q.sql)).sql, /version = version \+ 1/);
  assert.deepEqual(queries.find(q => /UPDATE duplicate_candidates[\s\S]*status = 'superseded'/.test(q.sql)).params, ['d1', 'b', 'a']);
  assert.deepEqual(queries.find(q => /UPDATE canonical_summaries SET stale/.test(q.sql)).params, [['b', 'a']]);
  const auditEvidence = queries.find(q => /INSERT INTO canonical_merge_operations/.test(q.sql)).params[7];
  assert.equal(auditEvidence.candidate.id, 'd1');
  assert.equal(auditEvidence.winner.title, 'B');
  assert.equal(auditEvidence.loser.text, 'alpha');
  assert.deepEqual(auditEvidence.counts, { movedSubmissions: 2, movedActionItems: 3, movedClosedLoops: 1 });
  assert.equal(queries.find(q => /INSERT INTO canonical_merge_operations/.test(q.sql)).params[9], 'review-token');
});

test('active feedback list filters merged rows and detail resolves aliases to the active winner', async () => {
  const listPool = scriptedPool([{ match: /WHERE cf\.merged_into_id IS NULL/, result: { rows: [] } }]).pool;
  assert.equal((await invoke(createCanonicalApiHandler({ pool: listPool }), 'GET', '/api/canonical/feedback')).status, 200);

  const { pool } = scriptedPool([
    { match: /canonical_feedback_aliases/, result: { rows: [{ resolved_id: 'winner', resolved_from: 'loser' }] } },
    { match: /WHERE cf\.id = \$1[\s\S]*merged_into_id IS NULL/s, result: { rows: [{ id: 'winner', canonical_text: 'kept', version: 2, created_at: 'now', updated_at: 'now', closed: true }] } },
    { match: /FROM feedback_submissions/, result: { rows: [] } }
  ]);
  const result = await invoke(createCanonicalApiHandler({ pool }), 'GET', '/api/canonical/feedback/loser');
  assert.equal(result.status, 200);
  assert.equal(result.json.id, 'winner');
  assert.equal(result.json.resolvedFrom, 'loser');
});

test('candidate review routes require a configured constant-time token while canonical reads remain public', async () => {
  const pool = { async query() { return { rows: [] }; }, async connect() { throw new Error('must not connect'); } };
  const unconfigured = createCanonicalApiHandler({ pool, mergeReviewToken: '' });
  const configured = handlerFor(pool);

  assert.equal((await invoke(unconfigured, 'GET', '/api/canonical/duplicate-candidates?initiativeId=i1')).status, 503);
  assert.equal((await invoke(configured, 'GET', '/api/canonical/duplicate-candidates?initiativeId=i1')).status, 401);
  assert.equal((await invoke(configured, 'GET', '/api/canonical/duplicate-candidates?initiativeId=i1', undefined, { 'x-merge-review-token': 'wrong' })).status, 401);
  assert.equal((await invoke(createCanonicalApiHandler({ pool: null, mergeReviewToken: REVIEW_TOKEN }), 'GET', '/api/canonical/duplicate-candidates?initiativeId=i1')).status, 401);
  assert.equal((await invoke(configured, 'GET', '/api/canonical/feedback')).status, 200);
});

test('candidate decisions reject caller-supplied actor labels before database access', async () => {
  const pool = { async connect() { throw new Error('unused'); } };
  const reject = await invoke(handlerFor(pool), 'POST', '/api/canonical/duplicate-candidates/d1/reject',
    { expectedVersion: 1, decidedBy: 'spoof' }, { 'Idempotency-Key': 'reject-actor-0001', ...REVIEW_HEADERS });
  const confirm = await invoke(handlerFor(pool), 'POST', '/api/canonical/duplicate-candidates/d1/confirm',
    { winnerId: 'a', loserId: 'b', expectedVersion: 1, expectedWinnerVersion: 1, expectedLoserVersion: 1, reason: 'same', decidedBy: 'spoof' },
    { 'Idempotency-Key': 'confirm-actor-001', ...REVIEW_HEADERS });
  assert.equal(reject.status, 400);
  assert.equal(confirm.status, 400);
});

test('candidate boundaries reject low thresholds, oversized initiatives, and nullable cursors', async () => {
  const unused = { async query() { throw new Error('unused'); }, async connect() { throw new Error('unused'); } };
  const low = await invoke(handlerFor(unused), 'POST', '/api/canonical/duplicate-candidates/generate',
    { initiativeId: 'i1', threshold: 0.29 }, { 'Idempotency-Key': 'generate-key-0002', ...REVIEW_HEADERS });
  assert.equal(low.status, 400);

  const cursor = Buffer.from(JSON.stringify({ score: null, id: 'd1' })).toString('base64url');
  assert.equal((await invoke(handlerFor(unused), 'GET', `/api/canonical/duplicate-candidates?initiativeId=i1&cursor=${cursor}`, undefined, REVIEW_HEADERS)).status, 400);

  const { pool } = scriptedPool([
    { match: /BEGIN/ }, { match: /lock_timeout/ }, { match: /statement_timeout/ },
    { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: null }] } },
    { match: /FROM initiatives.*FOR UPDATE/s, result: { rows: [{ id: 'i1' }] } },
    { match: /COUNT\(\*\).*canonical_feedback/s, result: { rows: [{ active_count: '5001' }] } }, { match: /ROLLBACK/ }
  ]);
  const tooLarge = await invoke(handlerFor(pool), 'POST', '/api/canonical/duplicate-candidates/generate',
    { initiativeId: 'i1' }, { 'Idempotency-Key': 'generate-key-0003', ...REVIEW_HEADERS });
  assert.equal(tooLarge.status, 409);
});

test('confirm rejects candidate evidence generated from stale canonical versions before reparenting', async () => {
  const body = { winnerId: 'b', loserId: 'a', expectedVersion: 4, expectedWinnerVersion: 3, expectedLoserVersion: 2, reason: 'same' };
  const { pool, queries } = scriptedPool([
    { match: /BEGIN/ }, { match: /lock_timeout/ }, { match: /statement_timeout/ },
    { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: null }] } },
    { match: /FROM canonical_feedback[\s\S]*FOR UPDATE/, result: { rows: [{ id: 'a', initiative_id: 'i1', version: 2, merged_into_id: null }, { id: 'b', initiative_id: 'i1', version: 3, merged_into_id: null }] } },
    { match: /FROM duplicate_candidates[\s\S]*FOR UPDATE/, result: { rows: [{ id: 'd1', canonical_feedback_id: 'a', candidate_feedback_id: 'b', status: 'pending', version: 4, evidence: { leftVersion: 1, rightVersion: 3 } }] } },
    { match: /ROLLBACK/ }
  ]);
  const result = await invoke(handlerFor(pool), 'POST', '/api/canonical/duplicate-candidates/d1/confirm', body,
    { 'Idempotency-Key': 'confirm-key-0002', ...REVIEW_HEADERS });
  assert.equal(result.status, 409);
  assert.equal(queries.some(q => /UPDATE feedback_submissions/.test(q.sql)), false);
});

test('detail and attach resolve immutable alias chains recursively with a depth and cycle guard', async () => {
  const { pool: detailPool, queries: detailQueries } = scriptedPool([
    { match: /WITH RECURSIVE alias_chain[\s\S]*depth < 32[\s\S]*NOT .* ANY/s, result: { rows: [{ resolved_id: 'c', resolved_from: 'a' }] } },
    { match: /FROM canonical_feedback cf/, result: { rows: [{ id: 'c', canonical_text: 'kept', version: 1, created_at: 'now', updated_at: 'now', closed: false }] } },
    { match: /FROM feedback_submissions/, result: { rows: [] } }
  ]);
  assert.equal((await invoke(createCanonicalApiHandler({ pool: detailPool }), 'GET', '/api/canonical/feedback/a')).json.id, 'c');
  assert.ok(detailQueries[0].sql.includes('WITH RECURSIVE'));

  const body = { provider: { name: 'P' }, originalText: 'O' };
  const { pool: attachPool } = scriptedPool([
    { match: /BEGIN/ }, { match: /lock_timeout/ }, { match: /statement_timeout/ },
    { match: /DELETE FROM api_idempotency/ }, { match: /INSERT INTO api_idempotency/, result: { rows: [{ request_hash: null }] } },
    { match: /WITH RECURSIVE alias_chain[\s\S]*FOR UPDATE OF active/s, result: { rows: [{ id: 'c', initiative_id: null }] } },
    { match: /INSERT INTO feedback_submissions/ }, { match: /UPDATE api_idempotency/ }, { match: /COMMIT/ }
  ]);
  assert.equal((await invoke(createCanonicalApiHandler({ pool: attachPool }), 'POST', '/api/canonical/feedback/a/submissions', body,
    { 'Idempotency-Key': 'attach-chain-0001' })).json.canonicalFeedbackId, 'c');
});

test('native intake requires nonempty originalText and bounds canonical and original text to 20000 characters', async () => {
  const pool = { async query() { throw new Error('unused'); }, async connect() { throw new Error('unused'); } };
  const handler = createCanonicalApiHandler({ pool });
  const headers = { 'Idempotency-Key': 'native-bounds-001' };
  assert.equal((await invoke(handler, 'POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T' }, headers)).status, 400);
  assert.equal((await invoke(handler, 'POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'x'.repeat(20001), originalText: 'O' }, headers)).status, 400);
  assert.equal((await invoke(handler, 'POST', '/api/canonical/feedback', { provider: { name: 'P' }, canonicalText: 'T', originalText: 'x'.repeat(20001) }, headers)).status, 400);
});
