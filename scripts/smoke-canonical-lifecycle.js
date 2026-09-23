const { createHash, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { createPool } = require('../server/db');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function deterministicUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function smokeIds(injected = {}) {
  const ids = {
    canonicalId: injected.canonicalId || randomUUID(),
    submissionIds: injected.submissionIds || [randomUUID(), randomUUID()],
    loopIds: injected.loopIds || (injected.submissionIds || []).map(id => deterministicUuid(`closed-loop:${id}`))
  };
  if (ids.loopIds.length === 0) ids.loopIds = ids.submissionIds.map(id => deterministicUuid(`closed-loop:${id}`));
  const fields = [['canonicalId', [ids.canonicalId]], ['submissionIds', ids.submissionIds], ['loopIds', ids.loopIds]];
  for (const [name, values] of fields) {
    if (values.length !== (name === 'canonicalId' ? 1 : 2) || values.some(value => !UUID_PATTERN.test(value))) {
      throw new Error(`${name} must be ${name === 'canonicalId' ? 'a valid UUID' : 'two valid UUIDs'}`);
    }
  }
  return ids;
}

async function runCanonicalLifecycleSmoke({ pool, logger = console, ids: injectedIds } = {}) {
  if (!pool) throw new Error('DATABASE_URL is required to run the canonical lifecycle smoke');
  const ids = smokeIds(injectedIds);
  const client = await pool.connect();
  const stages = [];
  let residualCounts;
  let primaryError;
  let cleanupError;
  let rollbackSucceeded = false;

  const status = async (stage, expected) => {
    const result = await client.query(
      'SELECT closed FROM canonical_feedback_status WHERE canonical_feedback_id = $1',
      [ids.canonicalId]
    );
    const closed = Boolean(result.rows[0]?.closed);
    assert.equal(closed, expected, `${stage} expected canonical closed=${expected}`);
    stages.push({ stage, closed });
    logger.log(JSON.stringify({ stage, closed }));
  };

  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(
      'INSERT INTO canonical_feedback (id, canonical_text) VALUES ($1, $2)',
      [ids.canonicalId, 'Synthetic canonical lifecycle smoke feedback']
    );
    await client.query(`
      INSERT INTO feedback_submissions
        (id, canonical_feedback_id, provider_snapshot, source_data)
      VALUES ($1, $3, $4, $6), ($2, $3, $5, $6)`,
    [
      ids.submissionIds[0], ids.submissionIds[1], ids.canonicalId,
      { name: 'Smoke Provider A' }, { name: 'Smoke Provider B' }, { sourceType: 'smoke' }
    ]);
    await status('missing loops', false);
    await client.query(`
      INSERT INTO closed_loops (id, canonical_feedback_id, feedback_submission_id, closed)
      VALUES ($1, $2, $3, TRUE)`, [ids.loopIds[0], ids.canonicalId, ids.submissionIds[0]]);
    await status('first loop closed', false);
    await client.query(`
      INSERT INTO closed_loops (id, canonical_feedback_id, feedback_submission_id, closed)
      VALUES ($1, $2, $3, TRUE)`, [ids.loopIds[1], ids.canonicalId, ids.submissionIds[1]]);
    await status('all loops closed', true);
    const reopened = await client.query(`
      UPDATE closed_loops SET closed = $2, version = version + 1, updated_at = NOW()
      WHERE id = $1 AND version = $3
      RETURNING version`, [ids.loopIds[0], false, 1]);
    assert.equal(reopened.rowCount, 1, 'first loop expected version 1');
    await status('first loop reopened', false);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await client.query('ROLLBACK');
      rollbackSucceeded = true;
    } catch (error) {
      cleanupError = error;
    }

    try {
      const result = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM canonical_feedback WHERE id = $1) AS canonical_count,
          (SELECT COUNT(*) FROM feedback_submissions WHERE id = ANY($2::TEXT[])) AS submission_count,
          (SELECT COUNT(*) FROM closed_loops WHERE id = ANY($3::TEXT[])) AS loop_count`,
      [ids.canonicalId, ids.submissionIds, ids.loopIds]);
      const row = result.rows[0];
      residualCounts = {
        canonical: Number(row.canonical_count),
        submissions: Number(row.submission_count),
        loops: Number(row.loop_count)
      };
      logger.log(JSON.stringify({ status: 'rolled back', residualCounts, ids }));
      assert.deepEqual(residualCounts, { canonical: 0, submissions: 0, loops: 0 }, 'residual rows remain after rollback');
    } catch (error) {
      if (!cleanupError) cleanupError = error;
    } finally {
      client.release(rollbackSucceeded ? undefined : cleanupError || new Error('rollback state is unknown'));
    }
  }

  if (primaryError) {
    if (cleanupError) primaryError.cleanupError = cleanupError;
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return { stages, residualCounts, rolledBack: true };
}

async function main({ pool = createPool(), logger = console, ids } = {}) {
  try {
    const report = await runCanonicalLifecycleSmoke({ pool, logger, ids });
    logger.log(JSON.stringify(report));
    return report;
  } finally {
    if (pool) await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ status: 'failed', error: error.message, cleanupError: error.cleanupError?.message }));
    process.exitCode = 1;
  });
}

module.exports = { main, runCanonicalLifecycleSmoke };
