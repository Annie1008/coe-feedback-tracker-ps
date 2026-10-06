const { createPool } = require('../server/db');
const { CUTOVER_LOCK_ID } = require('../server/cutoverState');
const { hashLegacySourcePayload, checkCanonicalIntegrity, parityFailureMessage } = require('./activate-canonical-cutover');
const { reconcileFieldInputs } = require('./reconcile-field-inputs');
const { checkParity } = require('./check-field-input-parity');

const EXPECTED_REPAIRED_IDS = [
  'msq6vb42tfye7ecenr9', 'msq6vb42ie7fpc0evvi', 'msq6vb42ik22wsjs4tr', 'msq6vb42beegrxssd2k',
  'msq6vb42820nc5nfkpk', 'msq6vb42373kaatno9g', 'msq6vb42nyp7iry6tuh', 'msq6vb42socnjb7m6c9',
  'msq6vb42lhh6q01hlnc', 'msq6vb429pwmqcjv3rs', 'msq6vb424q8x3naqog3', 'msq6vb42b9tp64lexte',
  'msq6vb42ge01m0uth', 'msq6vb42g1jvr77ih5u', 'msq6vb42y66isr9e7ge', 'msq6vb42nt9yim60xtj',
  'msq6vb42qmw1vx3362', 'msq6vb424eh8ad6df8n', 'msq6vb425v0rmv1dfct', 'msq6vb42qw7f41un2dl'
];
const EXPECTED_MISSING_PREFIXES = { mulfm1hz: 43, muf9tzry: 1 };
const UNASSIGNED_EMPTY_INITIATIVE_IDS = [
  'mruu2dz88yjpyaqcm4n', 'mruu2dz8ear9lq1g1dc', 'mruu2dz8kkcjf9zaium',
  'mruu2dz8r1vykgciad', 'mruu2dz8y9nnumn6fb'
];

function summarizeRepairTargets(payload) {
  const feedback = payload?.feedback || [];
  const byId = new Map(feedback.map(row => [String(row.id), row]));
  const repaired = EXPECTED_REPAIRED_IDS.map(id => {
    const row = byId.get(id);
    if (!row) throw new Error(`Expected Donald Lefevre source row ${id} is missing from app_data`);
    if (String(row.initiativeId) !== '1') throw new Error(`Expected ${id} to still belong to initiative 1 in source`);
    if (row.providerName !== 'Donald Lefevre') throw new Error(`Expected ${id} providerName Donald Lefevre`);
    return id;
  });
  const missing = feedback
    .map(row => String(row.id))
    .filter(id => Object.keys(EXPECTED_MISSING_PREFIXES).some(prefix => id.startsWith(prefix)));
  const missingByPrefix = Object.fromEntries(Object.keys(EXPECTED_MISSING_PREFIXES).map(prefix => [
    prefix, missing.filter(id => id.startsWith(prefix)).length
  ]));
  for (const [prefix, expected] of Object.entries(EXPECTED_MISSING_PREFIXES)) {
    if (missingByPrefix[prefix] !== expected) {
      throw new Error(`Expected ${expected} missing ${prefix}* source rows, found ${missingByPrefix[prefix]}`);
    }
  }
  const unassigned = UNASSIGNED_EMPTY_INITIATIVE_IDS.map(id => {
    const row = byId.get(id);
    if (!row) throw new Error(`Expected unassigned source row ${id} is missing from app_data`);
    if (row.initiativeId !== '') throw new Error(`Expected ${id} to keep an empty-string initiativeId`);
    return id;
  });
  return { repaired, missing, unassigned };
}

async function repairPreCutoverSourceDrift({ pool } = {}) {
  if (!pool) throw new Error('DATABASE_URL is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [CUTOVER_LOCK_ID]);
    const source = await client.query("SELECT payload, updated_at FROM app_data WHERE id='main' FOR UPDATE");
    if (!source.rows[0]) throw new Error('app_data main payload was not found');
    const state = await client.query(`SELECT stage, initial_cutover_completed_at, baseline_source_payload_hash
      FROM canonical_cutover_state WHERE name='field-inputs' FOR UPDATE`);
    if (state.rows[0]?.stage !== 'legacy_read_only') {
      throw new Error(`Operator repair refused: expected legacy_read_only, found ${state.rows[0]?.stage || 'missing'}`);
    }
    if (state.rows[0]?.initial_cutover_completed_at || state.rows[0]?.baseline_source_payload_hash) {
      throw new Error('Operator repair refused: initial cutover provenance already exists');
    }
    const targets = summarizeRepairTargets(source.rows[0].payload);
    const existingRepaired = await client.query(`SELECT fs.legacy_feedback_id, fs.initiative_id AS submission_initiative,
      cf.initiative_id AS parent_initiative, cf.merged_into_id, cf.retired_at, fs.raw_legacy
      FROM feedback_submissions fs JOIN canonical_feedback cf ON cf.id=fs.canonical_feedback_id
      WHERE fs.legacy_feedback_id=ANY($1::TEXT[]) FOR UPDATE OF fs, cf`, [targets.repaired]);
    if (existingRepaired.rows.length !== targets.repaired.length) {
      throw new Error(`Expected ${targets.repaired.length} imported Donald Lefevre rows, found ${existingRepaired.rows.length}`);
    }
    for (const row of existingRepaired.rows) {
      if (row.merged_into_id || row.retired_at) throw new Error(`Donald Lefevre row ${row.legacy_feedback_id} is merged or retired`);
      if (row.submission_initiative !== null || row.parent_initiative !== null) {
        throw new Error(`Donald Lefevre row ${row.legacy_feedback_id} is no longer the null-initiative import`);
      }
      const importedInitiativeId = row.raw_legacy?.initiativeId;
      if (!(importedInitiativeId === '' || importedInitiativeId == null)) {
        throw new Error(`Donald Lefevre raw_legacy ${row.legacy_feedback_id} is not the empty-initiative import (found ${JSON.stringify(importedInitiativeId)})`);
      }
    }
    const alreadyPresent = await client.query(
      'SELECT legacy_feedback_id FROM feedback_submissions WHERE legacy_feedback_id=ANY($1::TEXT[])',
      [targets.missing]
    );
    if (alreadyPresent.rows.length) {
      throw new Error(`Missing-source rows already exist in canonical: ${alreadyPresent.rows.map(row => row.legacy_feedback_id).join(', ')}`);
    }
    const unassigned = await client.query(`SELECT fs.legacy_feedback_id, fs.initiative_id
      FROM feedback_submissions fs WHERE fs.legacy_feedback_id=ANY($1::TEXT[])`, [targets.unassigned]);
    if (unassigned.rows.some(row => row.initiative_id !== null)) {
      throw new Error('Empty-string source rows are no longer unassigned in canonical');
    }
    await client.query(`UPDATE canonical_feedback SET initiative_id='1', version=version+1, updated_at=NOW()
      WHERE id=ANY($1::TEXT[]) AND initiative_id IS NULL AND merged_into_id IS NULL AND retired_at IS NULL`,
    [targets.repaired]);
    const reconciliation = await reconcileFieldInputs({ client, source: source.rows[0] });
    const parity = await checkParity({ client, payload: source.rows[0].payload });
    if (!parity.ok) throw new Error(parityFailureMessage(parity));
    const integrity = await checkCanonicalIntegrity(client);
    await client.query('COMMIT');
    return {
      repaired: targets.repaired,
      imported: reconciliation.imported,
      updated: reconciliation.updated,
      deleted: reconciliation.deleted,
      unassignedKeptNull: targets.unassigned,
      sourcePayloadHash: hashLegacySourcePayload(source.rows[0].payload),
      integrity,
      parity: { legacyCount: parity.legacyCount, canonicalCount: parity.canonicalCount }
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function main() {
  const pool = createPool();
  try { console.log(JSON.stringify(await repairPreCutoverSourceDrift({ pool }), null, 2)); }
  finally { if (pool) await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
module.exports = { repairPreCutoverSourceDrift, summarizeRepairTargets, EXPECTED_REPAIRED_IDS, UNASSIGNED_EMPTY_INITIATIVE_IDS };
