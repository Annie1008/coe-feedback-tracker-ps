const crypto = require('node:crypto');
const { createPool } = require('../server/db');
const { reconcileFieldInputs } = require('./reconcile-field-inputs');
const { checkParity } = require('./check-field-input-parity');

const { CUTOVER_LOCK_ID } = require('../server/cutoverState');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashLegacySourcePayload = payload => hash({
  initiatives: payload?.initiatives || [], feedback: payload?.feedback || [], closedLoop: payload?.closedLoop || {}
});

async function checkCanonicalIntegrity(client) {
  const result = await client.query(`SELECT
    (SELECT COUNT(*) FROM feedback_submissions fs LEFT JOIN canonical_feedback cf ON cf.id=fs.canonical_feedback_id WHERE cf.id IS NULL) AS orphan_submissions,
    (SELECT COUNT(*) FROM feedback_submissions fs WHERE fs.initiative_id IS DISTINCT FROM
      (SELECT cf.initiative_id FROM canonical_feedback cf WHERE cf.id=fs.canonical_feedback_id)
      AND NOT EXISTS (
        WITH RECURSIVE alias_chain AS (
          SELECT source.id, COALESCE(alias.canonical_feedback_id,source.merged_into_id) AS next_id,
            0 AS depth, ARRAY[source.id]::TEXT[] AS path
          FROM canonical_feedback source
          LEFT JOIN canonical_feedback_aliases alias ON alias.alias_id=source.id
          WHERE source.id=fs.legacy_feedback_id
          UNION ALL
          SELECT target.id, COALESCE(alias.canonical_feedback_id,target.merged_into_id),
            chain.depth+1, chain.path || target.id
          FROM alias_chain chain
          JOIN canonical_feedback target ON target.id=chain.next_id
          LEFT JOIN canonical_feedback_aliases alias ON alias.alias_id=target.id
          WHERE chain.next_id IS NOT NULL AND chain.depth < 32
            AND NOT target.id=ANY(chain.path)
        )
        SELECT 1 FROM alias_chain chain
        WHERE chain.id=fs.canonical_feedback_id AND chain.next_id IS NULL AND chain.depth > 0
      )) AS submission_initiative_mismatches,
    (SELECT COUNT(*) FROM action_items ai JOIN feedback_submissions fs ON fs.id=ai.feedback_submission_id
      WHERE ai.canonical_feedback_id IS DISTINCT FROM fs.canonical_feedback_id) AS action_parent_mismatches,
    (SELECT COUNT(*) FROM closed_loops cl JOIN feedback_submissions fs ON fs.id=cl.feedback_submission_id
      WHERE cl.canonical_feedback_id IS DISTINCT FROM fs.canonical_feedback_id) AS loop_parent_mismatches,
    (SELECT COUNT(*) FROM canonical_feedback cf WHERE cf.merged_into_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM canonical_feedback winner WHERE winner.id=cf.merged_into_id)) AS missing_merge_winners`);
  const counts = Object.fromEntries(Object.entries(result.rows[0] || {}).map(([key, value]) => [key, Number(value)]));
  if (Object.values(counts).some(value => value !== 0)) throw new Error(`Canonical integrity failed: ${JSON.stringify(counts)}`);
  return counts;
}

function parityFailureMessage(report) {
  const keys = ['mismatches','missingIds','extraIds','duplicateLegacyIds','duplicateCanonicalIds','relationshipErrors','initiativeMismatches','extraInitiativeIds'];
  const counts = keys.map(key => `${key}=${report[key]?.length || 0}`).join(', ');
  const sampleIds = keys.flatMap(key => (report[key] || []).slice(0, 3).map(item => `${key}:${typeof item === 'object' ? item.id : item}`)).slice(0, 10);
  return `Field Inputs parity failed: legacyCount=${report.legacyCount || 0}, canonicalCount=${report.canonicalCount || 0}, ${counts}${sampleIds.length ? `, sampleIds=${sampleIds.join('|')}` : ''}. Run npm run parity:field-inputs for details.`;
}

async function activateCanonicalCutover({ pool } = {}) {
  if (!pool) throw new Error('DATABASE_URL is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [CUTOVER_LOCK_ID]);
    const source = await client.query("SELECT payload, updated_at FROM app_data WHERE id='main' FOR UPDATE");
    if (!source.rows[0]) throw new Error('app_data main payload was not found');
    const sourceHash = hashLegacySourcePayload(source.rows[0].payload);
    const stateResult = await client.query(`SELECT initial_cutover_completed_at,baseline_source_payload_hash
      FROM canonical_cutover_state WHERE name='field-inputs' FOR UPDATE`);
    const initialCutoverCompletedAt = stateResult.rows[0]?.initial_cutover_completed_at || null;
    const baselineSourcePayloadHash = stateResult.rows[0]?.baseline_source_payload_hash || null;
    let activationMode, reconciliation = null, parity = null;
    if (initialCutoverCompletedAt) {
      if (!baselineSourcePayloadHash) throw new Error('Completed cutover is missing its durable baseline source hash');
      if (sourceHash !== baselineSourcePayloadHash) {
        throw new Error(`Legacy source drift detected after initial cutover; explicit operator migration required (baseline ${baselineSourcePayloadHash}, current ${sourceHash})`);
      }
      activationMode = 'repeat_integrity_only';
    } else {
      activationMode = 'initial_reconciliation';
      reconciliation = await reconcileFieldInputs({ client, source: source.rows[0] });
      parity = await checkParity({ client, payload: source.rows[0].payload });
      if (!parity.ok) throw new Error(parityFailureMessage(parity));
    }
    const integrity = await checkCanonicalIntegrity(client);
    await client.query(`INSERT INTO canonical_cutover_state
      (name,stage,source_payload_hash,source_updated_at,stage_changed_at,details,initial_cutover_completed_at,baseline_source_payload_hash)
      VALUES ('field-inputs','canonical_active',$1,$2,NOW(),$3,NOW(),$1)
      ON CONFLICT (name) DO UPDATE SET stage='canonical_active', source_payload_hash=EXCLUDED.source_payload_hash,
        source_updated_at=EXCLUDED.source_updated_at, stage_changed_at=NOW(), details=EXCLUDED.details,
        initial_cutover_completed_at=COALESCE(canonical_cutover_state.initial_cutover_completed_at,EXCLUDED.initial_cutover_completed_at),
        baseline_source_payload_hash=COALESCE(canonical_cutover_state.baseline_source_payload_hash,EXCLUDED.baseline_source_payload_hash)`,
    [sourceHash, source.rows[0].updated_at, { activationMode, integrity, reconciliation,
      parity: parity && { legacyCount: parity.legacyCount, canonicalCount: parity.canonicalCount } }]);
    await client.query('COMMIT');
    return { stage: 'canonical_active', activationMode,
      initialCutoverCompletedAt: initialCutoverCompletedAt || 'set-by-transaction',
      baselineSourcePayloadHash: baselineSourcePayloadHash || sourceHash,
      currentSourcePayloadHash: sourceHash, sourcePayloadHash: sourceHash, integrity, reconciliation, parity };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function main() {
  const pool = createPool();
  try { console.log(JSON.stringify(await activateCanonicalCutover({ pool }), null, 2)); }
  finally { if (pool) await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
module.exports = { activateCanonicalCutover, checkCanonicalIntegrity, hashLegacySourcePayload, parityFailureMessage };
