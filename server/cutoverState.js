const STAGES = new Set(['legacy_read_only', 'canonical_active']);
const CUTOVER_LOCK_ID = 1184913902;

function configuredStage(env = process.env) {
  const value = env.CANONICAL_FIELD_INPUTS_STAGE;
  if (!value) return null;
  if (value === 'barrier') return 'legacy_read_only';
  if (value === 'canonical') return null; // Database activation remains authoritative; this only removes the emergency barrier.
  throw new Error('CANONICAL_FIELD_INPUTS_STAGE must be barrier or canonical');
}

async function readCutoverState(db, env = process.env) {
  const override = configuredStage(env);
  if (override === 'legacy_read_only') return { name: 'field-inputs', stage: override, emergencyReadOnly: true };
  const result = await db.query(`SELECT name,stage,source_payload_hash,source_updated_at,stage_changed_at,
      initial_cutover_completed_at,baseline_source_payload_hash
    FROM canonical_cutover_state WHERE name='field-inputs'`);
  const row = result.rows[0];
  const stage = row && STAGES.has(row.stage) ? row.stage : 'legacy_read_only';
  return { name: 'field-inputs', stage, sourcePayloadHash: row?.source_payload_hash || null,
    sourceUpdatedAt: row?.source_updated_at || null, stageChangedAt: row?.stage_changed_at || null,
    initialCutoverCompletedAt: row?.initial_cutover_completed_at || null,
    baselineSourcePayloadHash: row?.baseline_source_payload_hash || null };
}

module.exports = { readCutoverState, configuredStage, CUTOVER_LOCK_ID };
