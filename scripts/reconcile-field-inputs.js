const { createPool } = require('../server/db');
const { buildLegacyImportPlan, importLegacyData } = require('../server/legacyImport');

function assertLegacyChildProvenance(entity, row) {
  if (row.raw_legacy === null || row.raw_legacy === undefined) {
    throw new Error(`Native ${entity} collision: ${row.id}${row.feedback_submission_id ? ` on ${row.feedback_submission_id}` : ''}`);
  }
  if (row.submission_canonical_feedback_id !== undefined &&
      row.canonical_feedback_id !== row.submission_canonical_feedback_id) {
    throw new Error(`${entity} provenance conflict: ${row.id || row.feedback_submission_id}`);
  }
}

async function reconcileFieldInputs({ pool, client, source } = {}) {
  if (!client && !pool) throw new Error('DATABASE_URL is required');
  const ownClient = !client;
  client ||= await pool.connect();
  try {
    if (ownClient) {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='60s'");
      await client.query('SELECT pg_advisory_xact_lock($1)', [1184913902]);
    }
    source ||= (await client.query("SELECT payload,updated_at FROM app_data WHERE id='main' FOR UPDATE")).rows[0];
    if (!source) throw new Error('app_data main payload was not found');
    const plan = buildLegacyImportPlan(source.payload, { sourceUpdatedAt: source.updated_at, snapshotId: `reconcile:${new Date(source.updated_at).toISOString()}` });

    const sourceInitiativeIds = plan.initiatives.map(row => row.id);
    if (sourceInitiativeIds.length) {
      const collisions = await client.query(`SELECT id FROM initiatives
        WHERE id=ANY($1::TEXT[]) AND legacy_imported=FALSE ORDER BY id FOR UPDATE`, [sourceInitiativeIds]);
      if (collisions.rows.length) throw new Error(`Legacy initiative ID collision with native canonical initiative: ${collisions.rows.map(row => row.id).join(', ')}`);
    }

    // Lock and validate every row that can collide before the first upsert. A non-null
    // raw_legacy marker plus the submission's current canonical parent is the ownership boundary.
    const desiredActionIds = plan.actions.map(row => row.id);
    const desiredLoopSubmissionIds = plan.closedLoops.map(row => row.feedbackSubmissionId);
    const actionConflicts = desiredActionIds.length ? await client.query(`SELECT ai.id,ai.feedback_submission_id,
      ai.canonical_feedback_id,ai.raw_legacy,fs.canonical_feedback_id AS submission_canonical_feedback_id
      FROM action_items ai JOIN feedback_submissions fs ON fs.id=ai.feedback_submission_id
      WHERE ai.id=ANY($1::TEXT[]) ORDER BY ai.id FOR UPDATE OF ai,fs`, [desiredActionIds]) : { rows: [] };
    for (const row of actionConflicts.rows) {
      assertLegacyChildProvenance('action item', row);
      const desired = plan.actions.find(action => action.id === row.id);
      if (!desired || row.feedback_submission_id !== desired.feedbackSubmissionId) {
        throw new Error(`Action item provenance conflict: ${row.id}`);
      }
    }
    const loopConflicts = desiredLoopSubmissionIds.length ? await client.query(`SELECT cl.id,cl.feedback_submission_id,
      cl.canonical_feedback_id,cl.raw_legacy,fs.canonical_feedback_id AS submission_canonical_feedback_id
      FROM closed_loops cl JOIN feedback_submissions fs ON fs.id=cl.feedback_submission_id
      WHERE cl.id=ANY($1::TEXT[]) OR cl.feedback_submission_id=ANY($2::TEXT[])
      ORDER BY cl.id FOR UPDATE OF cl,fs`, [plan.closedLoops.map(row => row.id), desiredLoopSubmissionIds]) : { rows: [] };
    for (const row of loopConflicts.rows) {
      assertLegacyChildProvenance('closed loop', row);
      const desired = plan.closedLoops.find(loop => loop.feedbackSubmissionId === row.feedback_submission_id);
      if (!desired || (row.id !== desired.id && plan.closedLoops.some(loop => loop.id === row.id))) {
        throw new Error(`Closed loop provenance conflict: ${row.id}`);
      }
    }

    // Retire source-absent legacy feedback before resolving stale initiatives. The
    // historical rows remain intact; deleting an eligible initiative only clears
    // their initiative_id through the schema's ON DELETE SET NULL relationships.
    const ids = plan.submissions.map(row => row.legacyFeedbackId);
    const existing = await client.query(`SELECT fs.id,fs.legacy_feedback_id,fs.canonical_feedback_id,cf.merged_into_id
      FROM feedback_submissions fs JOIN canonical_feedback cf ON cf.id=fs.canonical_feedback_id
      WHERE fs.legacy_feedback_id IS NOT NULL FOR UPDATE OF fs`, []);
    const present = new Map(existing.rows.map(row => [row.legacy_feedback_id, row]));
    const missingIds = new Set(ids.filter(id => !present.has(id)));
    const absent = existing.rows.filter(row => !ids.includes(row.legacy_feedback_id));
    const absentSubmissionIds = absent.map(row => row.id);
    const affectedParentIds = [...new Set(absent.map(row => row.canonical_feedback_id))];
    if (absentSubmissionIds.length) await client.query(`UPDATE feedback_submissions SET deleted_at=NOW(),version=version+1,updated_at=NOW()
      WHERE id=ANY($1::TEXT[]) AND deleted_at IS NULL`, [absentSubmissionIds]);
    if (affectedParentIds.length) await client.query(`UPDATE canonical_feedback cf SET retired_at=NOW(),version=version+1,updated_at=NOW()
      WHERE cf.id=ANY($1::TEXT[]) AND cf.merged_into_id IS NULL AND cf.retired_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM feedback_submissions fs WHERE fs.canonical_feedback_id=cf.id AND fs.deleted_at IS NULL)`, [affectedParentIds]);

    const staleInitiatives = await client.query(`SELECT id FROM initiatives
      WHERE legacy_imported=TRUE AND NOT (id=ANY($1::TEXT[])) ORDER BY id FOR UPDATE`, [sourceInitiativeIds]);
    const staleInitiativeIds = staleInitiatives.rows.map(row => row.id);
    if (staleInitiativeIds.length) {
      const dependencies = await client.query(`SELECT i.id,
        (SELECT COUNT(*) FROM canonical_feedback cf WHERE cf.initiative_id=i.id AND NOT (
          (cf.merged_into_id IS NOT NULL OR (cf.retired_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM feedback_submissions owned WHERE owned.canonical_feedback_id=cf.id)))
          AND NOT EXISTS (SELECT 1 FROM feedback_submissions active
            WHERE active.canonical_feedback_id=cf.id AND active.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM feedback_submissions native
            WHERE native.canonical_feedback_id=cf.id AND native.legacy_feedback_id IS NULL)
        )) AS canonical_feedback_count,
        (SELECT COUNT(*) FROM feedback_submissions fs
          WHERE fs.initiative_id=i.id AND fs.deleted_at IS NULL) AS submission_count,
        (SELECT COUNT(*) FROM canonical_merge_batches cmb WHERE cmb.initiative_id=i.id) AS merge_batch_count
        FROM initiatives i WHERE i.id=ANY($1::TEXT[]) ORDER BY i.id FOR UPDATE OF i`, [staleInitiativeIds]);
      const blocked = dependencies.rows.filter(row => [row.canonical_feedback_count,row.submission_count,row.merge_batch_count]
        .some(value => Number(value) > 0));
      if (blocked.length) throw new Error(`Stale legacy initiative has dependent canonical data: ${blocked.map(row => row.id).join(', ')}`);
      // initiative_enablement is the only owned child and has ON DELETE CASCADE.
      await client.query('DELETE FROM initiatives WHERE id=ANY($1::TEXT[]) AND legacy_imported=TRUE', [staleInitiativeIds]);
    }
    for (const initiative of plan.initiatives) await client.query(`INSERT INTO initiatives
      (id,name,description,rollout_date,color,legacy_imported) VALUES ($1,$2,$3,$4,$5,TRUE)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,
        rollout_date=EXCLUDED.rollout_date,color=EXCLUDED.color,updated_at=NOW(),
        version=CASE WHEN (initiatives.name,initiatives.description,initiatives.rollout_date,initiatives.color)
          IS DISTINCT FROM (EXCLUDED.name,EXCLUDED.description,EXCLUDED.rollout_date,EXCLUDED.color)
          THEN initiatives.version+1 ELSE initiatives.version END
      WHERE initiatives.legacy_imported`,
    [initiative.id,initiative.name,initiative.description,initiative.rolloutDate,initiative.color]);
    if (sourceInitiativeIds.length) await client.query('DELETE FROM initiative_enablement WHERE initiative_id=ANY($1::TEXT[])', [sourceInitiativeIds]);
    for (const row of plan.enablement) await client.query(`INSERT INTO initiative_enablement
      (id,initiative_id,ou_key,original_ordinal,format,enabled_on,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [row.id,row.initiativeId,row.ouKey,row.originalOrdinal,row.format,row.enabledOn,row.details]);

    if (missingIds.size) {
      const requiredInitiativeIds = new Set(plan.submissions.filter(row => missingIds.has(row.legacyFeedbackId)).map(row => row.initiativeId).filter(Boolean));
      const payload = { ...source.payload,
        initiatives: (source.payload.initiatives || []).filter(row => requiredInitiativeIds.has(String(row.id))),
        feedback: (source.payload.feedback || []).filter(row => missingIds.has(String(row.id))),
        closedLoop: Object.fromEntries(Object.entries(source.payload.closedLoop || {}).filter(([id]) => missingIds.has(id))) };
      await importLegacyData({ client, payload, sourceUpdatedAt: source.updated_at, snapshotId: plan.snapshot.id, manageTransaction: false, allowAfterMerges: true, acquireLock: false });
    }

    let updated = 0;
    for (const submission of plan.submissions.filter(row => present.has(row.legacyFeedbackId))) {
      const current = present.get(submission.legacyFeedbackId);
      // Preserve raw_legacy and the canonical parent/text (including merge winners); refresh only compatibility fields.
      await client.query(`UPDATE feedback_submissions SET initiative_id=$2,provider_snapshot=$3,source_data=$4,
        submitted_on=$5,source_created_at=$6,original_text=$7,submission_attributes=$8,updated_at=NOW(),version=version+1
        ,deleted_at=NULL WHERE id=$1 AND (deleted_at IS NOT NULL OR
          (initiative_id,provider_snapshot,source_data,submitted_on,source_created_at,original_text,submission_attributes)
          IS DISTINCT FROM ($2,$3,$4,$5,$6,$7,$8))`,
      [current.id, submission.initiativeId, submission.providerSnapshot, submission.sourceData, submission.submittedOn,
        submission.sourceCreatedAt, submission.originalText, submission.submissionAttributes]);
      await client.query(`UPDATE canonical_feedback SET retired_at=NULL,version=version+1,updated_at=NOW()
        WHERE id=$1 AND merged_into_id IS NULL AND retired_at IS NOT NULL`, [current.canonical_feedback_id]);
      const desiredActions = plan.actions.filter(action => action.legacyFeedbackId === submission.legacyFeedbackId || action.feedbackSubmissionId === submission.id);
      const desiredActionIds = desiredActions.map(action => action.id);
      await client.query(`DELETE FROM action_items WHERE feedback_submission_id=$1 AND raw_legacy IS NOT NULL
        AND NOT (id=ANY($2::TEXT[]))`, [current.id, desiredActionIds]);
      for (const action of desiredActions) await client.query(`INSERT INTO action_items
        (id,canonical_feedback_id,feedback_submission_id,legacy_snapshot_id,original_ordinal,raw_legacy,text,done,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,NOW())) ON CONFLICT (id) DO UPDATE SET
          text=EXCLUDED.text,done=EXCLUDED.done,original_ordinal=EXCLUDED.original_ordinal,updated_at=NOW(),version=action_items.version+1`,
      [action.id, current.canonical_feedback_id, current.id, action.legacySnapshotId, action.originalOrdinal, action.rawLegacy, action.text, action.done, action.createdAt]);
      const desiredLoop = plan.closedLoops.find(loop => loop.feedbackSubmissionId === submission.id);
      if (desiredLoop) await client.query(`INSERT INTO closed_loops
        (id,canonical_feedback_id,feedback_submission_id,legacy_snapshot_id,raw_legacy,how_incorporated,communicated_back,communication_method,closed_date,closed,notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (feedback_submission_id) DO UPDATE SET
          how_incorporated=EXCLUDED.how_incorporated,communicated_back=EXCLUDED.communicated_back,
          communication_method=EXCLUDED.communication_method,closed_date=EXCLUDED.closed_date,closed=EXCLUDED.closed,
          notes=EXCLUDED.notes,updated_at=NOW(),version=closed_loops.version+1`,
      [desiredLoop.id,current.canonical_feedback_id,current.id,desiredLoop.legacySnapshotId,desiredLoop.rawLegacy,
        desiredLoop.howIncorporated,desiredLoop.communicatedBack,desiredLoop.communicationMethod,desiredLoop.closedDate,desiredLoop.closed,desiredLoop.notes]);
      if (!desiredLoop) await client.query('DELETE FROM closed_loops WHERE feedback_submission_id=$1 AND raw_legacy IS NOT NULL', [current.id]);
      updated += 1;
    }
    if (ownClient) await client.query('COMMIT');
    return { imported: missingIds.size, updated, deleted: absentSubmissionIds.length, missing: [...missingIds] };
  } catch (error) {
    if (ownClient) await client.query('ROLLBACK');
    throw error;
  } finally { if (ownClient) client.release(); }
}

async function main() { const pool=createPool(); try { console.log(JSON.stringify(await reconcileFieldInputs({pool}),null,2)); } finally { if(pool) await pool.end(); } }
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error:error.message })); process.exitCode=1; });
module.exports = { reconcileFieldInputs };
