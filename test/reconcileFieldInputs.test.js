const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { reconcileFieldInputs } = require('../scripts/reconcile-field-inputs');

test('reconciliation upserts initiatives and enablement before importing missing feedback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/reconcile-field-inputs.js'), 'utf8');
  const initiative = source.indexOf('INSERT INTO initiatives');
  const enablement = source.indexOf('INSERT INTO initiative_enablement');
  const missingImport = source.indexOf('await importLegacyData');
  assert.ok(initiative >= 0 && enablement > initiative && missingImport > enablement);
  assert.match(source, /DELETE FROM initiative_enablement/);
  assert.match(source, /initiatives: .*filter/);
  assert.match(source, /legacy_imported/);
  assert.match(source, /initiative ID collision/i);
  assert.match(source, /ON CONFLICT \(id\) DO UPDATE[\s\S]*WHERE initiatives\.legacy_imported/i);
});

test('initial reconciliation soft-deletes absent imported rows, restores source-present rows, and retires only empty parents', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/reconcile-field-inputs.js'), 'utf8');
  assert.match(source, /legacy_feedback_id IS NOT NULL/);
  assert.match(source, /deleted_at\s*=\s*NOW\(\)/i);
  assert.match(source, /deleted_at\s*=\s*NULL/i);
  assert.match(source, /retired_at\s*=\s*NOW\(\)/i);
  assert.match(source, /NOT EXISTS[\s\S]*deleted_at IS NULL/i);
  assert.match(source, /retired_at IS NOT NULL[\s\S]*active\.deleted_at IS NULL[\s\S]*canonical_feedback_count/i);
  assert.match(source, /native\.legacy_feedback_id IS NULL[\s\S]*canonical_feedback_count/i);
  assert.match(source, /fs\.deleted_at IS NULL[\s\S]*submission_count/i);
});

test('initial reconciliation fails closed on a native initiative ID collision before overwrite', async () => {
  const queries = [];
  const client = { async query(sql) {
    queries.push(String(sql));
    if (/legacy_imported=FALSE/.test(sql)) return { rows: [{ id: 'shared' }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const source = { updated_at: '2026-01-01T00:00:00Z', payload: {
    initiatives: [{ id: 'shared', name: 'Legacy' }], feedback: [], closedLoop: {}
  } };
  await assert.rejects(reconcileFieldInputs({ client, source }), /initiative ID collision.*shared/i);
  assert.equal(queries.some(sql => /ON CONFLICT \(id\) DO UPDATE/.test(sql)), false);
});

function reconciliationClient(handler) {
  const queries = [];
  return { queries, client: { async query(sql, params = []) {
    queries.push({ sql: String(sql), params });
    return handler(String(sql), params, queries);
  } } };
}

test('initial reconciliation removes stale imported initiatives and cascaded enablement only', async () => {
  const { client, queries } = reconciliationClient(async sql => {
    if (/legacy_imported=FALSE/.test(sql)) return { rows: [] };
    if (/SELECT fs\.id[\s\S]*legacy_feedback_id IS NOT NULL/.test(sql)) return { rows: [] };
    if (/SELECT id FROM initiatives[\s\S]*legacy_imported=TRUE/.test(sql)) return { rows: [{ id: 'stale' }] };
    if (/canonical_feedback_count/.test(sql)) return { rows: [{ id: 'stale', canonical_feedback_count: '0', submission_count: '0', merge_batch_count: '0' }] };
    if (/SELECT fs\.id/.test(sql)) return { rows: [] };
    if (/FROM action_items[\s\S]*FOR UPDATE/.test(sql) || /FROM closed_loops[\s\S]*FOR UPDATE/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 1 };
  });
  await reconcileFieldInputs({ client, source: { updated_at: '2026-01-01Z', payload: { initiatives: [], feedback: [], closedLoop: {} } } });
  const deletion = queries.find(query => /DELETE FROM initiatives/.test(query.sql));
  assert.deepEqual(deletion.params, [['stale']]);
  assert.equal(queries.some(query => /DELETE FROM initiative_enablement[\s\S]*stale/.test(query.sql)), false,
    'enablement should be removed only by the initiative ON DELETE CASCADE');
});

test('initial reconciliation fails closed before deleting a stale imported initiative with canonical dependents', async () => {
  const { client, queries } = reconciliationClient(async sql => {
    if (/legacy_imported=FALSE/.test(sql)) return { rows: [] };
    if (/SELECT fs\.id[\s\S]*legacy_feedback_id IS NOT NULL/.test(sql)) return { rows: [] };
    if (/SELECT id FROM initiatives[\s\S]*legacy_imported=TRUE/.test(sql)) return { rows: [{ id: 'stale' }] };
    if (/canonical_feedback_count/.test(sql)) return { rows: [{ id: 'stale', canonical_feedback_count: '1', submission_count: '0', merge_batch_count: '0' }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  await assert.rejects(reconcileFieldInputs({ client, source: {
    updated_at: '2026-01-01Z', payload: { initiatives: [], feedback: [], closedLoop: {} }
  } }), /stale legacy initiative.*dependent canonical data.*stale/i);
  assert.equal(queries.some(query => /DELETE FROM initiatives/.test(query.sql)), false);
});

test('initial reconciliation retires removed legacy feedback before deleting its stale initiative', async () => {
  const state = {
    submissionDeleted: false,
    parentRetired: false,
    initiativeDeleted: false
  };
  const { client, queries } = reconciliationClient(async (sql, params) => {
    if (/legacy_imported=FALSE/.test(sql)) return { rows: [] };
    if (/FROM action_items[\s\S]*FOR UPDATE/.test(sql) || /FROM closed_loops[\s\S]*FOR UPDATE/.test(sql)) return { rows: [] };
    if (/SELECT fs\.id[\s\S]*legacy_feedback_id IS NOT NULL/.test(sql)) return { rows: [{
      id: 'legacy:removed-feedback', legacy_feedback_id: 'removed-feedback', canonical_feedback_id: 'removed-feedback', merged_into_id: null
    }] };
    if (/UPDATE feedback_submissions SET deleted_at=NOW/.test(sql)) {
      state.submissionDeleted = true;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE canonical_feedback cf SET retired_at=NOW/.test(sql)) {
      assert.equal(state.submissionDeleted, true, 'parent retirement must follow submission soft deletion');
      state.parentRetired = true;
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT id FROM initiatives[\s\S]*legacy_imported=TRUE/.test(sql)) return { rows: [{ id: 'removed-initiative' }] };
    if (/canonical_feedback_count/.test(sql)) return { rows: [{
      id: 'removed-initiative',
      canonical_feedback_count: state.parentRetired ? '0' : '1',
      submission_count: state.submissionDeleted ? '0' : '1',
      merge_batch_count: '0'
    }] };
    if (/DELETE FROM initiatives/.test(sql)) {
      assert.equal(state.submissionDeleted, true);
      assert.equal(state.parentRetired, true);
      state.initiativeDeleted = true;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });

  const result = await reconcileFieldInputs({ client, source: {
    updated_at: '2026-01-01Z', payload: { initiatives: [], feedback: [], closedLoop: {} }
  } });

  assert.deepEqual(result, { imported: 0, updated: 0, deleted: 1, missing: [] });
  assert.equal(state.initiativeDeleted, true);
  const softDelete = queries.findIndex(query => /UPDATE feedback_submissions SET deleted_at=NOW/.test(query.sql));
  const dependencyCheck = queries.findIndex(query => /canonical_feedback_count/.test(query.sql));
  assert.ok(softDelete >= 0 && dependencyCheck > softDelete, 'removed feedback must be retired before stale initiative dependency resolution');
});

test('initial reconciliation deletes a removed initiative whose feedback is a merged historical loser without deleting history', async () => {
  const state = { submissionDeleted: false, initiativeDeleted: false };
  const { client, queries } = reconciliationClient(async sql => {
    if (/legacy_imported=FALSE/.test(sql)) return { rows: [] };
    if (/FROM action_items[\s\S]*FOR UPDATE/.test(sql) || /FROM closed_loops[\s\S]*FOR UPDATE/.test(sql)) return { rows: [] };
    // Merge processing has already reparented the removed legacy submission to the winner,
    // leaving the historical loser canonical with no owned submissions.
    if (/SELECT fs\.id[\s\S]*legacy_feedback_id IS NOT NULL/.test(sql)) return { rows: [{
      id: 'legacy:merged-loser', legacy_feedback_id: 'merged-loser', canonical_feedback_id: 'winner', merged_into_id: null
    }] };
    if (/UPDATE feedback_submissions SET deleted_at=NOW/.test(sql)) {
      state.submissionDeleted = true;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE canonical_feedback cf SET retired_at=NOW/.test(sql)) return { rows: [], rowCount: 1 };
    if (/SELECT id FROM initiatives[\s\S]*legacy_imported=TRUE/.test(sql)) return { rows: [{ id: 'removed-initiative' }] };
    if (/canonical_feedback_count/.test(sql)) {
      const permitsEmptyMergedLoser = /cf\.merged_into_id IS NOT NULL\s+OR \(cf\.retired_at IS NOT NULL/.test(sql)
        && /NOT EXISTS \(SELECT 1 FROM feedback_submissions active/.test(sql)
        && /NOT EXISTS \(SELECT 1 FROM feedback_submissions native/.test(sql);
      return { rows: [{
        id: 'removed-initiative', canonical_feedback_count: permitsEmptyMergedLoser ? '0' : '1',
        submission_count: state.submissionDeleted ? '0' : '1', merge_batch_count: '0'
      }] };
    }
    if (/DELETE FROM initiatives/.test(sql)) {
      state.initiativeDeleted = true;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });

  const result = await reconcileFieldInputs({ client, source: {
    updated_at: '2026-01-01Z', payload: { initiatives: [], feedback: [], closedLoop: {} }
  } });

  assert.deepEqual(result, { imported: 0, updated: 0, deleted: 1, missing: [] });
  assert.equal(state.initiativeDeleted, true);
  assert.equal(queries.some(query => /DELETE FROM (canonical_feedback|feedback_submissions)/.test(query.sql)), false,
    'canonical and submission history must remain for FK detachment');
});

test('initial reconciliation still blocks stale initiatives with active, native, or merge dependencies', async () => {
  for (const [label, dependency] of Object.entries({
    'active-canonical': { canonical_feedback_count: '1', submission_count: '0', merge_batch_count: '0' },
    'active-submission': { canonical_feedback_count: '0', submission_count: '1', merge_batch_count: '0' },
    'native-submission': { canonical_feedback_count: '1', submission_count: '0', merge_batch_count: '0' },
    merge: { canonical_feedback_count: '0', submission_count: '0', merge_batch_count: '1' }
  })) {
    const { client, queries } = reconciliationClient(async sql => {
      if (/legacy_imported=FALSE/.test(sql)) return { rows: [] };
      if (/FROM action_items[\s\S]*FOR UPDATE/.test(sql) || /FROM closed_loops[\s\S]*FOR UPDATE/.test(sql)) return { rows: [] };
      if (/SELECT fs\.id[\s\S]*legacy_feedback_id IS NOT NULL/.test(sql)) return { rows: [] };
      if (/SELECT id FROM initiatives[\s\S]*legacy_imported=TRUE/.test(sql)) return { rows: [{ id: `stale-${label}` }] };
      if (/canonical_feedback_count/.test(sql)) return { rows: [{ id: `stale-${label}`, ...dependency }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await assert.rejects(reconcileFieldInputs({ client, source: {
      updated_at: '2026-01-01Z', payload: { initiatives: [], feedback: [], closedLoop: {} }
    } }), new RegExp(`dependent canonical data.*stale-${label}`, 'i'), label);
    assert.equal(queries.some(query => /DELETE FROM initiatives/.test(query.sql)), false, label);
  }
});

const provenancePayload = { initiatives: [{ id: 'i1', name: 'One' }], feedback: [{
  id: 'f1', initiativeId: 'i1', notes: 'Input', actionItems: [{ id: 'a1', text: 'Legacy action' }]
}], closedLoop: { f1: { notes: 'Legacy loop' } } };

test('reconciliation preflight rejects a native action ID collision before any upsert', async () => {
  const { client, queries } = reconciliationClient(async sql => {
    if (/legacy_imported=FALSE/.test(sql)) return { rows: [] };
    if (/SELECT id FROM initiatives[\s\S]*legacy_imported=TRUE/.test(sql)) return { rows: [] };
    if (/FROM action_items[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{
      id: 'a1', feedback_submission_id: 'legacy:f1', canonical_feedback_id: 'f1', raw_legacy: null
    }] };
    if (/FROM closed_loops[\s\S]*FOR UPDATE/.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  await assert.rejects(reconcileFieldInputs({ client, source: { updated_at: '2026-01-01Z', payload: provenancePayload } }),
    /native action item collision.*a1/i);
  assert.equal(queries.some(query => /INSERT INTO initiatives/.test(query.sql)), false);
});

test('reconciliation preflight rejects a native closed loop on the legacy submission even with a different ID', async () => {
  const { client, queries } = reconciliationClient(async sql => {
    if (/legacy_imported=FALSE/.test(sql)) return { rows: [] };
    if (/SELECT id FROM initiatives[\s\S]*legacy_imported=TRUE/.test(sql)) return { rows: [] };
    if (/FROM action_items[\s\S]*FOR UPDATE/.test(sql)) return { rows: [] };
    if (/FROM closed_loops[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{
      id: 'native-loop', feedback_submission_id: 'legacy:f1', canonical_feedback_id: 'f1', raw_legacy: null
    }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  await assert.rejects(reconcileFieldInputs({ client, source: { updated_at: '2026-01-01Z', payload: provenancePayload } }),
    /native closed loop collision.*legacy:f1/i);
  assert.equal(queries.some(query => /INSERT INTO initiatives/.test(query.sql)), false);
});

test('reconciliation accepts legacy-owned action and loop rows with matching submission/canonical provenance', async () => {
  const { client, queries } = reconciliationClient(async sql => {
    if (/legacy_imported=FALSE/.test(sql)) return { rows: [] };
    if (/SELECT id FROM initiatives[\s\S]*legacy_imported=TRUE/.test(sql)) return { rows: [] };
    if (/FROM action_items[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{
      id: 'a1', feedback_submission_id: 'legacy:f1', canonical_feedback_id: 'winner', raw_legacy: { text: 'Old' }
    }] };
    if (/FROM closed_loops[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{
      id: 'f1', feedback_submission_id: 'legacy:f1', canonical_feedback_id: 'winner', raw_legacy: { notes: 'Old' }
    }] };
    if (/SELECT fs\.id/.test(sql)) return { rows: [{ id: 'legacy:f1', legacy_feedback_id: 'f1', canonical_feedback_id: 'winner', merged_into_id: null }] };
    return { rows: [], rowCount: 1 };
  });
  await reconcileFieldInputs({ client, source: { updated_at: '2026-01-01Z', payload: provenancePayload } });
  assert.equal(queries.some(query => /ON CONFLICT \(id\) DO UPDATE SET[\s\S]*text=EXCLUDED\.text/.test(query.sql)), true);
  assert.equal(queries.some(query => /ON CONFLICT \(feedback_submission_id\) DO UPDATE SET/.test(query.sql)), true);
});

test('reconciliation rejects legacy-marked child rows whose canonical provenance does not match their submission', async () => {
  const { client } = reconciliationClient(async sql => {
    if (/legacy_imported=FALSE/.test(sql)) return { rows: [] };
    if (/SELECT id FROM initiatives[\s\S]*legacy_imported=TRUE/.test(sql)) return { rows: [] };
    if (/FROM action_items[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{
      id: 'a1', feedback_submission_id: 'legacy:f1', canonical_feedback_id: 'wrong', submission_canonical_feedback_id: 'winner', raw_legacy: { text: 'Old' }
    }] };
    if (/FROM closed_loops[\s\S]*FOR UPDATE/.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  await assert.rejects(reconcileFieldInputs({ client, source: { updated_at: '2026-01-01Z', payload: provenancePayload } }),
    /action item provenance conflict.*a1/i);
});
