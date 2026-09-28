const { isDeepStrictEqual } = require('node:util');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function canonicalText(feedback) {
  const fields = [
    ['notes', 'Notes'], ['frictionPoints', 'Friction points'], ['toolsMentioned', 'Tools mentioned'],
    ['workarounds', 'Workarounds'], ['dealImpact', 'Deal impact'], ['quotes', 'Quotes'],
    ['legacyText', 'Legacy text']
  ];
  return fields
    .filter(([field]) => typeof feedback[field] === 'string' && feedback[field].trim())
    .map(([field, label]) => `${label}: ${feedback[field].trim()}`)
    .join('\n');
}

const SUBMISSION_ATTRIBUTE_FIELDS = ['format', 'frictionPoints', 'toolsMentioned', 'workarounds', 'dealImpact', 'quotes', 'notes'];
function submissionAttributes(feedback) {
  return Object.fromEntries(SUBMISSION_ATTRIBUTE_FIELDS
    .filter(field => feedback[field] !== undefined && feedback[field] !== null)
    .map(field => [field, text(feedback[field])]));
}

function requiredSourceId(value, entity, ordinal) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${entity} at ordinal ${ordinal} is missing id`);
  }
  return String(value);
}

function assertUniqueIds(rows, entity) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`duplicate ${entity} id ${row.id}`);
    seen.add(row.id);
  }
}

function communicatedBack(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return text(value) || 'Pending';
}

function normalizedInstant(value) {
  if (value === undefined || value === null) return null;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(milliseconds) ? `invalid:${String(value)}` : milliseconds;
}

function uniqueActionId(requestedId, legacyFeedbackId, actionOrdinal, usedActionIds) {
  if (!usedActionIds.has(requestedId)) return requestedId;
  const fallback = `legacy:action:${legacyFeedbackId}:${actionOrdinal}:${requestedId}`;
  let candidate = fallback;
  let collision = 1;
  while (usedActionIds.has(candidate)) candidate = `${fallback}:${collision++}`;
  return candidate;
}

function buildLegacyImportPlan(payload, source = {}) {
  const rawPayload = clone(payload || {});
  const snapshotId = text(source.snapshotId || `legacy:${source.sourceUpdatedAt || rawPayload._savedAt || 'main'}`);
  const initiatives = (rawPayload.initiatives || []).map((initiative, originalOrdinal) => ({
    id: requiredSourceId(initiative.id, 'initiative', originalOrdinal),
    name: text(initiative.name),
    description: text(initiative.description),
    rolloutDate: initiative.rolloutDate || null,
    color: initiative.color || null,
    rawLegacy: clone(initiative)
  }));
  assertUniqueIds(initiatives, 'initiative');
  const initiativeIds = new Set(initiatives.map(initiative => initiative.id));
  const enablement = initiatives.flatMap(initiative =>
    Object.entries(initiative.rawLegacy.ouEnablement || {}).map(([region, details], originalOrdinal) => ({
      id: `legacy:initiative:${initiative.id}:${region}`,
      initiativeId: initiative.id,
      ouKey: region,
      originalOrdinal,
      format: text(details?.format),
      enabledOn: details?.date || null,
      details: { ...clone(details || {}), region }
    }))
  );
  const usedActionIds = new Set();
  const canonicalFeedback = [];
  const submissions = [];
  const actions = [];
  const feedbackRows = rawPayload.feedback || [];
  const feedbackSourceIds = feedbackRows.map((feedback, originalOrdinal) => ({
    id: requiredSourceId(feedback.id, 'feedback', originalOrdinal)
  }));
  assertUniqueIds(feedbackSourceIds, 'feedback');

  feedbackRows.forEach((feedback, originalOrdinal) => {
    const legacyFeedbackId = feedbackSourceIds[originalOrdinal].id;
    const feedbackSubmissionId = `legacy:${legacyFeedbackId}`;
    const initiativeId = feedback.initiativeId !== undefined && initiativeIds.has(text(feedback.initiativeId))
      ? text(feedback.initiativeId)
      : null;
    const importedCanonicalText = canonicalText(feedback);
    canonicalFeedback.push({
      id: legacyFeedbackId,
      initiativeId,
      canonicalText: importedCanonicalText,
      createdAt: feedback.createdAt || null
    });
    submissions.push({
      id: feedbackSubmissionId,
      canonicalFeedbackId: legacyFeedbackId,
      initiativeId,
      snapshotId,
      legacyFeedbackId,
      originalOrdinal,
      providerSnapshot: {
        name: text(feedback.providerName),
        role: text(feedback.providerRole),
        region: text(feedback.region)
      },
      sourceData: {
        date: feedback.date || null,
        createdAt: feedback.createdAt || null
      },
      rawLegacy: clone(feedback),
      submittedOn: feedback.date || null,
      sourceCreatedAt: feedback.createdAt || null,
      originalText: importedCanonicalText
      ,submissionAttributes: submissionAttributes(feedback)
    });
    (feedback.actionItems || []).forEach((action, actionOrdinal) => {
      const requestedId = text(action.id || `legacy:action:${legacyFeedbackId}:${actionOrdinal}`);
      const id = uniqueActionId(requestedId, legacyFeedbackId, actionOrdinal, usedActionIds);
      usedActionIds.add(id);
      actions.push({
        id,
        canonicalFeedbackId: legacyFeedbackId,
        feedbackSubmissionId,
        legacySnapshotId: snapshotId,
        originalOrdinal: actionOrdinal,
        text: text(action.text),
        done: Boolean(action.done),
        createdAt: action.createdAt || null,
        rawLegacy: clone(action)
      });
    });
  });

  const feedbackIds = new Set(canonicalFeedback.map(feedback => feedback.id));
  const closedLoops = [];
  const orphanClosedLoopIds = [];
  for (const [feedbackId, closedLoop] of Object.entries(rawPayload.closedLoop || {})) {
    if (!feedbackIds.has(feedbackId)) {
      orphanClosedLoopIds.push(feedbackId);
      continue;
    }
    closedLoops.push({
      id: feedbackId,
      canonicalFeedbackId: feedbackId,
      feedbackSubmissionId: `legacy:${feedbackId}`,
      legacySnapshotId: snapshotId,
      howIncorporated: text(closedLoop.howIncorporated),
      communicatedBack: communicatedBack(closedLoop.communicatedBack),
      communicationMethod: text(closedLoop.communicationMethod),
      closedDate: closedLoop.closedDate || null,
      closed: Boolean(closedLoop.closed),
      notes: text(closedLoop.notes),
      rawLegacy: clone(closedLoop)
    });
  }

  return {
    snapshot: { id: snapshotId, rawLegacy: rawPayload, sourceUpdatedAt: source.sourceUpdatedAt || null },
    initiatives,
    enablement,
    canonicalFeedback,
    submissions,
    actions,
    closedLoops,
    orphanClosedLoopIds
  };
}

async function insertEquivalent(client, sql, params, entity, id) {
  const result = await client.query(sql, params);
  if (result.rowCount !== 1) throw new Error(`conflicting existing ${entity} ${id}`);
}

function projectLegacyData(rows) {
  const raw = rows?.snapshot?.rawLegacy ?? rows?.snapshot?.raw_legacy ?? rows?.rawLegacy ?? rows?.raw_legacy;
  if (raw === undefined) throw new Error('legacy snapshot is required for projection');
  return clone(raw);
}

async function importLegacyData({ client, payload, sourceUpdatedAt = null, snapshotId, manageTransaction = true, allowAfterMerges = false, acquireLock = true }) {
  if (!client) throw new Error('client is required');
  const plan = buildLegacyImportPlan(payload, { sourceUpdatedAt, snapshotId });
  if (manageTransaction) await client.query('BEGIN');
  try {
    if (acquireLock) await client.query('SELECT pg_advisory_xact_lock($1)', [1184913902]);
    const mergeState = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM canonical_feedback WHERE merged_into_id IS NOT NULL
      ) AS has_merges`);
    if (mergeState.rows[0]?.has_merges && !allowAfterMerges) {
      throw new Error('legacy import refused: canonical merges already exist');
    }
    const snapshotResult = await client.query(
      'SELECT raw_legacy, source_updated_at FROM legacy_import_snapshots WHERE id = $1',
      [plan.snapshot.id]
    );
    if (snapshotResult.rows[0] && (
      !isDeepStrictEqual(snapshotResult.rows[0].raw_legacy, plan.snapshot.rawLegacy) ||
      normalizedInstant(snapshotResult.rows[0].source_updated_at) !== normalizedInstant(plan.snapshot.sourceUpdatedAt)
    )) {
      throw new Error(`conflicting existing legacy snapshot ${plan.snapshot.id}`);
    }

    const legacyIds = plan.submissions.map(submission => submission.legacyFeedbackId);
    const existing = legacyIds.length === 0 ? { rows: [] } : await client.query(
      'SELECT legacy_feedback_id, raw_legacy FROM feedback_submissions WHERE legacy_feedback_id = ANY($1::TEXT[])',
      [legacyIds]
    );
    for (const row of existing.rows) {
      const incoming = plan.submissions.find(submission => submission.legacyFeedbackId === row.legacy_feedback_id);
      if (!isDeepStrictEqual(row.raw_legacy, incoming.rawLegacy)) {
        throw new Error(`conflicting existing legacy feedback ${row.legacy_feedback_id}`);
      }
    }

    await insertEquivalent(client,
      `INSERT INTO legacy_import_snapshots (id, raw_legacy, source_updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       WHERE legacy_import_snapshots.raw_legacy = EXCLUDED.raw_legacy
         AND legacy_import_snapshots.source_updated_at IS NOT DISTINCT FROM EXCLUDED.source_updated_at`,
      [plan.snapshot.id, plan.snapshot.rawLegacy, plan.snapshot.sourceUpdatedAt],
      'legacy snapshot', plan.snapshot.id);
    for (const initiative of plan.initiatives) {
      await insertEquivalent(client,
        `INSERT INTO initiatives (id, name, description, rollout_date, color, legacy_imported) VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         WHERE initiatives.legacy_imported
           AND initiatives.name = EXCLUDED.name AND initiatives.description = EXCLUDED.description
           AND initiatives.rollout_date IS NOT DISTINCT FROM EXCLUDED.rollout_date
           AND initiatives.color IS NOT DISTINCT FROM EXCLUDED.color`,
        [initiative.id, initiative.name, initiative.description, initiative.rolloutDate, initiative.color],
        'initiative', initiative.id);
    }
    for (const row of plan.enablement) {
      await insertEquivalent(client,
        `INSERT INTO initiative_enablement (id, initiative_id, ou_key, original_ordinal, format, enabled_on, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         WHERE initiative_enablement.initiative_id = EXCLUDED.initiative_id
           AND initiative_enablement.ou_key = EXCLUDED.ou_key
           AND initiative_enablement.original_ordinal = EXCLUDED.original_ordinal
           AND initiative_enablement.format = EXCLUDED.format
            AND initiative_enablement.enabled_on IS NOT DISTINCT FROM EXCLUDED.enabled_on
            AND initiative_enablement.details = EXCLUDED.details`,
        [row.id, row.initiativeId, row.ouKey, row.originalOrdinal, row.format, row.enabledOn, row.details],
        'initiative enablement', row.id);
    }
    for (const feedback of plan.canonicalFeedback) {
      await insertEquivalent(client,
        `INSERT INTO canonical_feedback (id, initiative_id, canonical_text, created_at)
         VALUES ($1, $2, $3, COALESCE($4, NOW())) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         WHERE canonical_feedback.initiative_id IS NOT DISTINCT FROM EXCLUDED.initiative_id
           AND canonical_feedback.canonical_text = EXCLUDED.canonical_text
           AND ($4::TIMESTAMPTZ IS NULL OR canonical_feedback.created_at = $4::TIMESTAMPTZ)`,
        [feedback.id, feedback.initiativeId, feedback.canonicalText, feedback.createdAt],
        'canonical feedback', feedback.id);
    }
    for (const submission of plan.submissions) {
      await insertEquivalent(client,
        `INSERT INTO feedback_submissions
          (id, canonical_feedback_id, initiative_id, legacy_snapshot_id, legacy_feedback_id, original_ordinal,
            provider_snapshot, raw_legacy, source_data, submitted_on, source_created_at, original_text, submission_attributes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         WHERE feedback_submissions.canonical_feedback_id = EXCLUDED.canonical_feedback_id
           AND feedback_submissions.initiative_id IS NOT DISTINCT FROM EXCLUDED.initiative_id
           AND feedback_submissions.legacy_snapshot_id = EXCLUDED.legacy_snapshot_id
           AND feedback_submissions.legacy_feedback_id = EXCLUDED.legacy_feedback_id
           AND feedback_submissions.original_ordinal = EXCLUDED.original_ordinal
           AND feedback_submissions.provider_snapshot = EXCLUDED.provider_snapshot
           AND feedback_submissions.raw_legacy = EXCLUDED.raw_legacy
           AND feedback_submissions.source_data = EXCLUDED.source_data
           AND feedback_submissions.submitted_on IS NOT DISTINCT FROM EXCLUDED.submitted_on
            AND feedback_submissions.source_created_at IS NOT DISTINCT FROM EXCLUDED.source_created_at
            AND feedback_submissions.original_text = EXCLUDED.original_text
            AND feedback_submissions.submission_attributes = EXCLUDED.submission_attributes`,
        [submission.id, submission.canonicalFeedbackId, submission.initiativeId, submission.snapshotId,
          submission.legacyFeedbackId, submission.originalOrdinal, submission.providerSnapshot,
          submission.rawLegacy, submission.sourceData, submission.submittedOn, submission.sourceCreatedAt, submission.originalText,
          submission.submissionAttributes],
        'feedback submission', submission.id);
    }
    for (const action of plan.actions) {
      await insertEquivalent(client,
        `INSERT INTO action_items
           (id, canonical_feedback_id, feedback_submission_id, legacy_snapshot_id, original_ordinal, raw_legacy, text, done, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         WHERE action_items.canonical_feedback_id = EXCLUDED.canonical_feedback_id
           AND action_items.feedback_submission_id = EXCLUDED.feedback_submission_id
           AND action_items.legacy_snapshot_id = EXCLUDED.legacy_snapshot_id
           AND action_items.original_ordinal = EXCLUDED.original_ordinal
           AND action_items.raw_legacy = EXCLUDED.raw_legacy
           AND action_items.text = EXCLUDED.text AND action_items.done = EXCLUDED.done
           AND ($9::TIMESTAMPTZ IS NULL OR action_items.created_at = $9::TIMESTAMPTZ)`,
        [action.id, action.canonicalFeedbackId, action.feedbackSubmissionId, action.legacySnapshotId,
          action.originalOrdinal, action.rawLegacy, action.text, action.done, action.createdAt],
        'action item', action.id);
    }
    for (const closedLoop of plan.closedLoops) {
      await insertEquivalent(client,
        `INSERT INTO closed_loops
          (id, canonical_feedback_id, feedback_submission_id, legacy_snapshot_id, raw_legacy,
           how_incorporated, communicated_back, communication_method, closed_date, closed, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         WHERE closed_loops.canonical_feedback_id = EXCLUDED.canonical_feedback_id
           AND closed_loops.feedback_submission_id = EXCLUDED.feedback_submission_id
           AND closed_loops.legacy_snapshot_id = EXCLUDED.legacy_snapshot_id
           AND closed_loops.raw_legacy = EXCLUDED.raw_legacy
           AND closed_loops.how_incorporated = EXCLUDED.how_incorporated
           AND closed_loops.communicated_back = EXCLUDED.communicated_back
           AND closed_loops.communication_method = EXCLUDED.communication_method
           AND closed_loops.closed_date IS NOT DISTINCT FROM EXCLUDED.closed_date
           AND closed_loops.closed = EXCLUDED.closed AND closed_loops.notes = EXCLUDED.notes`,
        [closedLoop.id, closedLoop.canonicalFeedbackId, closedLoop.feedbackSubmissionId,
          closedLoop.legacySnapshotId, closedLoop.rawLegacy, closedLoop.howIncorporated,
          closedLoop.communicatedBack, closedLoop.communicationMethod, closedLoop.closedDate,
          closedLoop.closed, closedLoop.notes],
        'closed loop', closedLoop.id);
    }
    if (manageTransaction) await client.query('COMMIT');
  } catch (error) {
    if (manageTransaction) await client.query('ROLLBACK');
    throw error;
  }

  return {
    snapshotId: plan.snapshot.id,
    initiatives: plan.initiatives.length,
    enablement: plan.enablement.length,
    canonicalFeedback: plan.canonicalFeedback.length,
    submissions: plan.submissions.length,
    actionItems: plan.actions.length,
    closedLoops: plan.closedLoops.length,
    orphanClosedLoopIds: plan.orphanClosedLoopIds
  };
}

module.exports = { buildLegacyImportPlan, importLegacyData, projectLegacyData };
