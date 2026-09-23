const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'scripts', 'smoke-canonical-lifecycle.js');
const ids = {
  canonicalId: '11111111-1111-4111-8111-111111111111',
  submissionIds: ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'],
  loopIds: ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']
};

function loadScript() {
  return require(scriptPath);
}

function fakeDatabase({ statuses = [false, false, true, false], failAt } = {}) {
  const queries = [];
  let statusIndex = 0;
  let released = false;
  let releaseError;
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (queries.length === failAt) throw new Error('query failed');
      if (/FROM canonical_feedback_status/.test(sql)) return { rows: [{ closed: statuses[statusIndex++] }] };
      if (/UPDATE closed_loops/.test(sql)) return { rowCount: 1, rows: [{ version: 2 }] };
      if (/canonical_count/.test(sql)) {
        return { rows: [{ canonical_count: '0', submission_count: '0', loop_count: '0' }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release(error) { released = true; releaseError = error; }
  };
  return {
    client,
    pool: { async connect() { return client; } },
    queries,
    released: () => released,
    releaseError: () => releaseError
  };
}

test('exposes the canonical lifecycle smoke script through npm', () => {
  const packageJson = require('../package.json');

  assert.equal(fs.existsSync(scriptPath), true);
  assert.equal(packageJson.scripts['smoke:canonical'], 'node scripts/smoke-canonical-lifecycle.js');
});

test('runs every canonical status transition, rolls back, and verifies zero residual rows', async () => {
  const database = fakeDatabase();
  const logs = [];
  const { runCanonicalLifecycleSmoke } = loadScript();

  const report = await runCanonicalLifecycleSmoke({
    pool: database.pool,
    ids,
    logger: { log(message) { logs.push(message); } }
  });

  assert.deepEqual(report.stages.map(stage => stage.closed), [false, false, true, false]);
  assert.deepEqual(report.residualCounts, { canonical: 0, submissions: 0, loops: 0 });
  assert.equal(report.rolledBack, true);
  assert.equal(database.released(), true);
  assert.equal(database.releaseError(), undefined);
  assert.deepEqual(database.queries.slice(0, 3).map(query => query.sql.trim()), [
    'BEGIN',
    "SET LOCAL lock_timeout = '5s'",
    "SET LOCAL statement_timeout = '15s'"
  ]);
  assert.equal(database.queries.filter(query => /FROM canonical_feedback_status/.test(query.sql)).length, 4);
  assert.deepEqual(database.queries.map(query => query.sql.trim().split(/\s+/).slice(0, 3).join(' ')), [
    'BEGIN',
    "SET LOCAL lock_timeout",
    "SET LOCAL statement_timeout",
    'INSERT INTO canonical_feedback',
    'INSERT INTO feedback_submissions',
    'SELECT closed FROM',
    'INSERT INTO closed_loops',
    'SELECT closed FROM',
    'INSERT INTO closed_loops',
    'SELECT closed FROM',
    'UPDATE closed_loops SET',
    'SELECT closed FROM',
    'ROLLBACK',
    'SELECT (SELECT COUNT(*)'
  ]);
  const update = database.queries.find(query => /UPDATE closed_loops/.test(query.sql));
  assert.match(update.sql, /version = version \+ 1/);
  assert.match(update.sql, /version = \$3/);
  assert.deepEqual(update.params, [ids.loopIds[0], false, 1]);
  assert.equal(database.queries.filter(query => query.sql.trim() === 'ROLLBACK').length, 1);
  assert.equal(database.queries.some(query => /COMMIT/.test(query.sql)), false);
  assert.match(database.queries.at(-1).sql, /canonical_count/);
  assert.ok(logs.every(line => !line.includes('DATABASE_URL')));
  assert.ok(logs.every(line => !line.includes('real provider')));
});

test('rolls back and verifies cleanup after a mid-step query failure without masking the primary error', async () => {
  const database = fakeDatabase({ failAt: 7 });
  const { runCanonicalLifecycleSmoke } = loadScript();

  await assert.rejects(
    runCanonicalLifecycleSmoke({ pool: database.pool, ids, logger: { log() {} } }),
    /query failed/
  );

  assert.equal(database.queries.filter(query => query.sql.trim() === 'ROLLBACK').length, 1);
  assert.match(database.queries.at(-1).sql, /canonical_count/);
  assert.equal(database.queries.some(query => /COMMIT/.test(query.sql)), false);
  assert.equal(database.released(), true);
});

test('rejects residual rows after rollback', async () => {
  const database = fakeDatabase();
  const originalQuery = database.client.query.bind(database.client);
  database.client.query = async (sql, params) => {
    const result = await originalQuery(sql, params);
    if (/canonical_count/.test(sql)) return { rows: [{ canonical_count: '1', submission_count: '0', loop_count: '0' }] };
    return result;
  };
  const { runCanonicalLifecycleSmoke } = loadScript();

  await assert.rejects(
    runCanonicalLifecycleSmoke({ pool: database.pool, ids, logger: { log() {} } }),
    /residual rows remain/
  );
  assert.equal(database.released(), true);
});

test('preserves the primary failure and attaches rollback or cleanup failure details', async () => {
  const database = fakeDatabase({ statuses: [true] });
  const originalQuery = database.client.query.bind(database.client);
  database.client.query = async (sql, params) => {
    if (sql.trim() === 'ROLLBACK') throw new Error('rollback failed');
    return originalQuery(sql, params);
  };
  const { runCanonicalLifecycleSmoke } = loadScript();

  await assert.rejects(
    runCanonicalLifecycleSmoke({ pool: database.pool, ids, logger: { log() {} } }),
    error => {
      assert.match(error.message, /missing loops/);
      assert.match(error.cleanupError.message, /rollback failed/);
      return true;
    }
  );
  assert.match(database.queries.at(-1).sql, /canonical_count/);
  assert.equal(database.released(), true);
  assert.match(database.releaseError().message, /rollback failed/);
});

test('requires a pool before connecting', async () => {
  const { runCanonicalLifecycleSmoke } = loadScript();
  await assert.rejects(runCanonicalLifecycleSmoke(), /DATABASE_URL is required/);
});

test('generates valid deterministic loop UUIDs from injected submission UUIDs', async () => {
  const database = fakeDatabase();
  const { runCanonicalLifecycleSmoke } = loadScript();
  const partialIds = { canonicalId: ids.canonicalId, submissionIds: ids.submissionIds };

  await runCanonicalLifecycleSmoke({ pool: database.pool, ids: partialIds, logger: { log() {} } });

  const loopInserts = database.queries.filter(query => /INSERT INTO closed_loops/.test(query.sql));
  const generated = loopInserts.map(query => query.params[0]);
  assert.ok(generated.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)));
  assert.deepEqual(generated, ['9eb55225-f0b2-4851-a62a-1180772fa381', '2f1bb614-e0a9-47b9-ad95-b678f3a1aa59']);
});

test('rejects invalid injected smoke IDs before connecting', async () => {
  let connected = false;
  const { runCanonicalLifecycleSmoke } = loadScript();

  await assert.rejects(
    runCanonicalLifecycleSmoke({
      pool: { async connect() { connected = true; } },
      ids: { ...ids, canonicalId: 'not-a-uuid' }
    }),
    /canonicalId must be a valid UUID/
  );
  assert.equal(connected, false);
});

test('CLI main ends its pool on success and failure', async () => {
  const { main } = loadScript();
  for (const statuses of [[false, false, true, false], [true]]) {
    const database = fakeDatabase({ statuses });
    let ended = false;
    database.pool.end = async () => { ended = true; };
    if (statuses.length === 1) {
      await assert.rejects(main({ pool: database.pool, logger: { log() {} } }), /missing loops/);
    } else {
      await main({ pool: database.pool, ids, logger: { log() {} } });
    }
    assert.equal(ended, true);
  }
});
