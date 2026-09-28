const { createPool } = require('../server/db');
const { runMigrations } = require('./migrate');
const { CUTOVER_LOCK_ID } = require('../server/cutoverState');
const { hashLegacySourcePayload } = require('./activate-canonical-cutover');

async function prepareCanonicalCutover({ pool, runMigrationsFn = runMigrations } = {}) {
  if (!pool) throw new Error('DATABASE_URL is required');
  await runMigrationsFn({ pool });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [CUTOVER_LOCK_ID]);
    const previous = await client.query(`SELECT stage,stage_changed_at,source_payload_hash,initial_cutover_completed_at,baseline_source_payload_hash
      FROM canonical_cutover_state WHERE name='field-inputs' FOR UPDATE`);
    if (previous.rows[0]?.stage === 'canonical_active' && !previous.rows[0].initial_cutover_completed_at) {
      const source = await client.query("SELECT payload FROM app_data WHERE id='main' FOR UPDATE");
      if (!source.rows[0]) throw new Error('app_data main payload was not found');
      const priorSourceHash = previous.rows[0].source_payload_hash;
      if (!priorSourceHash) {
        throw new Error('Active pre-006 cutover is missing source_payload_hash; explicit operator migration required before placing the barrier');
      }
      const currentSourceHash = hashLegacySourcePayload(source.rows[0].payload);
      if (currentSourceHash !== priorSourceHash) {
        throw new Error(`Active pre-006 cutover source mismatch; explicit operator migration required before placing the barrier (recorded ${priorSourceHash}, current ${currentSourceHash})`);
      }
      await client.query(`UPDATE canonical_cutover_state SET initial_cutover_completed_at=stage_changed_at,
        baseline_source_payload_hash=source_payload_hash WHERE name='field-inputs'`);
    }
    const result = await client.query(`
      INSERT INTO canonical_cutover_state (name, stage, stage_changed_at, details)
      VALUES ('field-inputs', 'legacy_read_only', NOW(), '{"reason":"barrier release; manual activation required"}'::JSONB)
      ON CONFLICT (name) DO UPDATE SET stage='legacy_read_only', stage_changed_at=NOW(), details=EXCLUDED.details
      RETURNING stage,initial_cutover_completed_at,baseline_source_payload_hash,source_payload_hash`);
    await client.query('COMMIT');
    const row = result.rows[0];
    return { stage: row.stage, initialCutoverCompletedAt: row.initial_cutover_completed_at || null,
      baselineSourcePayloadHash: row.baseline_source_payload_hash || null, sourcePayloadHash: row.source_payload_hash || null };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function main() {
  const pool = createPool();
  try { console.log(JSON.stringify(await prepareCanonicalCutover({ pool }), null, 2)); }
  finally { if (pool) await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareCanonicalCutover };
