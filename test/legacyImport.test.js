const assert = require('node:assert/strict');
const test = require('node:test');

let legacyImport = {};
try {
  legacyImport = require('../server/legacyImport');
} catch {}

const payload = {
  initiatives: [
    {
      id: 7,
      name: 'Signal',
      description: 'Find signals',
      rolloutDate: '2026-02-03',
      color: '#123456',
      owner: 'unknown field',
      ouEnablement: {
        Global: { enabled: true, date: '2026-02-04', format: 'Webinar', notes: 'recorded', audience: 42 },
        LATAM: { enabled: false, notes: 'planned' }
      }
    }
  ],
  feedback: [
    {
      id: 101,
      initiativeId: 7,
      providerName: 'Ada',
      providerRole: 'VP',
      region: 'Global',
      date: '2026-03-01',
      createdAt: '2026-03-01T12:30:00.000Z',
      notes: 'Primary note',
      frictionPoints: 'Friction',
      toolsMentioned: 'Sheet',
      workarounds: 'Manual',
      dealImpact: 'Delay',
      quotes: 'Direct quote',
      mystery: { nested: true },
      actionItems: [
        { id: 'same', text: 'First', done: false, createdAt: '2026-03-02T00:00:00.000Z', extra: 'kept' },
        { id: 'same', text: 'Second', done: true }
      ]
    },
    { id: 'feedback-2', providerName: 'Bob', providerRole: '', region: 'LATAM', legacyText: 'Fallback text' },
    { id: 'feedback-3', providerName: 'Cy', notes: '', frictionPoints: 'Only friction', initiativeId: 'missing' }
  ],
  closedLoop: {
    101: { howIncorporated: 'Shipped', communicatedBack: true, communicationMethod: 'Slack', closedDate: '2026-03-05', closed: true, notes: 'Done', unknown: 1 },
    'feedback-2': { communicatedBack: 'Pending', closed: false },
    orphan: { communicatedBack: false, notes: 'must report' }
  },
  _savedAt: 12345,
  topLevelUnknown: ['preserve', 'in snapshot'],
  podNotes: { group1: 'Pod note' },
  podAssignments: { group1: 'Core' },
  jiraIssues: [{ key: 'COE-1', summary: 'Backlog story' }],
  jiraSyncedAt: '2026-09-23T00:00:00.000Z',
  timelineOverrides: { group1: 'October' },
  timelineSuggestions: { group1: 'November' },
  timelineHistory: [{ id: 'move-1', groupId: 'group1' }],
  timelineNotes: { group1: 'Target rationale' },
  dumpedGroups: { group2: true },
  fixedGroups: { group3: true },
  manualJiraLinks: { group1: 'COE-1' }
};

test('builds a deterministic lossless plan and projects the original aggregate', () => {
  const plan = legacyImport.buildLegacyImportPlan?.(payload, {
    snapshotId: 'snapshot-1',
    sourceUpdatedAt: '2026-04-01T00:00:00.000Z'
  });

  assert.equal(plan.snapshot.id, 'snapshot-1');
  assert.deepEqual(plan.snapshot.rawLegacy, payload);
  assert.equal(plan.initiatives[0].id, '7');
  assert.equal(plan.initiatives[0].rawLegacy.owner, 'unknown field');
  assert.deepEqual(plan.enablement.map(row => [row.id, row.initiativeId, row.format, row.enabledOn, row.details]), [
    ['legacy:initiative:7:Global', '7', 'Webinar', '2026-02-04', { enabled: true, date: '2026-02-04', format: 'Webinar', notes: 'recorded', audience: 42, region: 'Global' }],
    ['legacy:initiative:7:LATAM', '7', '', null, { enabled: false, notes: 'planned', region: 'LATAM' }]
  ]);
  assert.deepEqual(plan.submissions.map(row => [row.id, row.legacyFeedbackId, row.originalOrdinal]), [
    ['legacy:101', '101', 0],
    ['legacy:feedback-2', 'feedback-2', 1],
    ['legacy:feedback-3', 'feedback-3', 2]
  ]);
  assert.deepEqual(plan.canonicalFeedback.map(row => [row.id, row.initiativeId, row.canonicalText]), [
    ['101', '7', 'Notes: Primary note\nFriction points: Friction\nTools mentioned: Sheet\nWorkarounds: Manual\nDeal impact: Delay\nQuotes: Direct quote'],
    ['feedback-2', null, 'Legacy text: Fallback text'],
    ['feedback-3', null, 'Friction points: Only friction']
  ]);
  assert.deepEqual(plan.submissions[0].providerSnapshot, { name: 'Ada', role: 'VP', region: 'Global' });
  assert.deepEqual(plan.submissions[0].submissionAttributes, {
    notes: 'Primary note', frictionPoints: 'Friction', toolsMentioned: 'Sheet',
    workarounds: 'Manual', dealImpact: 'Delay', quotes: 'Direct quote'
  });
  assert.equal('providerName' in plan.submissions[0].submissionAttributes, false);
  assert.equal(plan.submissions[0].submittedOn, '2026-03-01');
  assert.equal(plan.submissions[0].sourceCreatedAt, '2026-03-01T12:30:00.000Z');
  assert.equal(plan.submissions[0].originalText, plan.canonicalFeedback[0].canonicalText);
  assert.equal(plan.canonicalFeedback[0].createdAt, '2026-03-01T12:30:00.000Z');
  assert.deepEqual(plan.submissions[0].rawLegacy, payload.feedback[0]);
  assert.deepEqual(plan.actions.map(row => [row.id, row.feedbackSubmissionId, row.originalOrdinal, row.text, row.done]), [
    ['same', 'legacy:101', 0, 'First', false],
    ['legacy:action:101:1:same', 'legacy:101', 1, 'Second', true]
  ]);
  assert.deepEqual(plan.closedLoops.map(row => [row.feedbackSubmissionId, row.communicatedBack]), [
    ['legacy:101', 'Yes'],
    ['legacy:feedback-2', 'Pending']
  ]);
  assert.deepEqual(plan.actions[0].rawLegacy, payload.feedback[0].actionItems[0]);
  assert.equal(plan.actions[0].legacySnapshotId, 'snapshot-1');
  assert.deepEqual(plan.closedLoops[0].rawLegacy, payload.closedLoop[101]);
  assert.equal(plan.closedLoops[0].legacySnapshotId, 'snapshot-1');
  assert.deepEqual(plan.enablement.map(row => [row.ouKey, row.originalOrdinal]), [['Global', 0], ['LATAM', 1]]);
  assert.deepEqual(plan.orphanClosedLoopIds, ['orphan']);
  assert.deepEqual(legacyImport.projectLegacyData?.(plan), payload);
  assert.deepEqual(legacyImport.buildLegacyImportPlan?.(payload, {
    snapshotId: 'snapshot-1', sourceUpdatedAt: '2026-04-01T00:00:00.000Z'
  }), plan);
});

test('does not coerce a date-only submission date into a timestamp', () => {
  const plan = legacyImport.buildLegacyImportPlan({
    feedback: [{ id: 'date-only', date: '2026-03-01' }]
  }, { snapshotId: 'snapshot' });

  assert.equal(plan.submissions[0].submittedOn, '2026-03-01');
  assert.equal(plan.submissions[0].sourceCreatedAt, null);
  assert.equal(plan.canonicalFeedback[0].createdAt, null);
});

test('keeps a date-only enablement date as a calendar date', () => {
  const plan = legacyImport.buildLegacyImportPlan({
    initiatives: [{ id: 'initiative', ouEnablement: { Global: { date: '2026-02-04', format: 'Webinar' } } }]
  }, { snapshotId: 'snapshot' });

  assert.equal(plan.enablement[0].enabledOn, '2026-02-04');
  assert.equal('enabledAt' in plan.enablement[0], false);
});

test('rejects missing and duplicate source IDs before opening a transaction', async () => {
  const invalidPayloads = [
    [{ initiatives: [{ name: 'missing' }] }, /initiative at ordinal 0 is missing id/],
    [{ initiatives: [{ id: 'same' }, { id: 'same' }] }, /duplicate initiative id same/],
    [{ feedback: [{ notes: 'missing' }] }, /feedback at ordinal 0 is missing id/],
    [{ feedback: [{ id: 'same' }, { id: 'same' }] }, /duplicate feedback id same/]
  ];

  for (const [invalidPayload, expected] of invalidPayloads) {
    let queryCount = 0;
    await assert.rejects(
      legacyImport.importLegacyData({
        client: { async query() { queryCount += 1; } },
        payload: invalidPayload,
        snapshotId: 'invalid'
      }),
      expected
    );
    assert.equal(queryCount, 0);
  }
});

test('uses deterministic collision-safe fallback action IDs', () => {
  const plan = legacyImport.buildLegacyImportPlan({
    feedback: [{
      id: 'feedback',
      actionItems: [
        { id: 'legacy:action:feedback:2:same', text: 'Occupies fallback' },
        { id: 'same', text: 'Preserved' },
        { id: 'same', text: 'Needs fallback' }
      ]
    }]
  }, { snapshotId: 'snapshot' });

  assert.equal(new Set(plan.actions.map(action => action.id)).size, 3);
  assert.deepEqual(plan.actions.map(action => action.id), [
    'legacy:action:feedback:2:same',
    'same',
    'legacy:action:feedback:2:same:1'
  ]);
});

test('imports transactionally, captures an immutable snapshot, and reruns idempotently', async () => {
  const queries = [];
  const snapshots = new Map();
  const submissions = new Map();
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: sql.trim(), params: structuredClone(params) });
      if (/SELECT raw_legacy, source_updated_at FROM legacy_import_snapshots/.test(sql)) {
        return { rows: snapshots.has(params[0]) ? [structuredClone(snapshots.get(params[0]))] : [] };
      }
      if (/SELECT legacy_feedback_id, raw_legacy FROM feedback_submissions/.test(sql)) {
        return { rows: params[0].filter(id => submissions.has(id)).map(id => ({ legacy_feedback_id: id, raw_legacy: submissions.get(id) })) };
      }
      if (/INSERT INTO legacy_import_snapshots/.test(sql)) {
        snapshots.set(params[0], { raw_legacy: structuredClone(params[1]), source_updated_at: new Date(params[2]) });
      }
      if (/INSERT INTO feedback_submissions/.test(sql)) submissions.set(params[4], structuredClone(params[7]));
      return { rows: [], rowCount: 1 };
    }
  };

  const input = structuredClone(payload);
  const options = { client, payload: input, sourceUpdatedAt: '2026-04-01T00:00:00.000Z', snapshotId: 'snapshot-1' };
  const first = await legacyImport.importLegacyData?.(options);
  input.feedback[0].notes = 'mutated after import';
  const second = await legacyImport.importLegacyData?.({ ...options, payload: payload });

  assert.deepEqual(first, {
    snapshotId: 'snapshot-1', initiatives: 1, enablement: 2, canonicalFeedback: 3,
    submissions: 3, actionItems: 2, closedLoops: 2, orphanClosedLoopIds: ['orphan']
  });
  assert.deepEqual(second, first);
  assert.deepEqual(snapshots.get('snapshot-1').raw_legacy, payload);
  assert.equal(queries.filter(query => query.sql === 'BEGIN').length, 2);
  assert.equal(queries.filter(query => query.sql === 'COMMIT').length, 2);
  assert.equal(queries.some(query => query.sql === 'ROLLBACK'), false);
  const submissionInsert = queries.find(query => /INSERT INTO feedback_submissions/.test(query.sql));
  assert.match(submissionInsert.sql, /submission_attributes/);
  const initiativeInsert = queries.find(query => /INSERT INTO initiatives/.test(query.sql));
  assert.match(initiativeInsert.sql, /legacy_imported/);
  assert.match(initiativeInsert.sql, /WHERE initiatives\.legacy_imported/);
  assert.equal(queries.filter(query => /pg_advisory_xact_lock/.test(query.sql)).length, 2);
  assert.ok(queries.findIndex(query => /pg_advisory_xact_lock/.test(query.sql)) <
    queries.findIndex(query => /SELECT raw_legacy, source_updated_at FROM legacy_import_snapshots/.test(query.sql)));
  assert.equal(queries.some(query => /ON CONFLICT[\s\S]*DO NOTHING/.test(query.sql) && !/legacy_import_snapshots/.test(query.sql)), false);
  assert.ok(queries.filter(query => /^INSERT/.test(query.sql)).every(query => query.params.length > 0));
});

test('rejects a reused snapshot ID when source_updated_at differs', async () => {
  const commands = [];
  const client = {
    async query(sql) {
      commands.push(sql.trim());
      if (/SELECT raw_legacy/.test(sql)) {
        return { rows: [{ raw_legacy: structuredClone(payload), source_updated_at: new Date('2026-04-01T00:00:01.000Z') }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };

  await assert.rejects(
    legacyImport.importLegacyData({
      client, payload, snapshotId: 'snapshot-1', sourceUpdatedAt: '2026-04-01T00:00:00.000Z'
    }),
    /conflicting existing legacy snapshot snapshot-1/
  );
  assert.equal(commands.at(-1), 'ROLLBACK');
});

test('treats null source_updated_at values as equivalent', async () => {
  const client = {
    async query(sql) {
      if (/SELECT raw_legacy, source_updated_at/.test(sql)) {
        return { rows: [{ raw_legacy: {}, source_updated_at: null }] };
      }
      if (/SELECT legacy_feedback_id/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 1 };
    }
  };

  await assert.doesNotReject(legacyImport.importLegacyData({
    client, payload: {}, snapshotId: 'snapshot', sourceUpdatedAt: null
  }));
});

test('snapshot conflict SQL requires exact raw payload and source instant equivalence', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql.trim());
      if (/SELECT raw_legacy/.test(sql)) return { rows: [] };
      if (/SELECT legacy_feedback_id/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 1 };
    }
  };

  await legacyImport.importLegacyData({
    client, payload: {}, snapshotId: 'snapshot', sourceUpdatedAt: '2026-04-01T00:00:00.000Z'
  });

  const snapshotInsert = queries.find(sql => /INSERT INTO legacy_import_snapshots/.test(sql));
  assert.match(snapshotInsert, /ON CONFLICT[\s\S]*raw_legacy[\s\S]*source_updated_at/i);
  assert.doesNotMatch(snapshotInsert, /ON CONFLICT\s*\(id\)\s*DO NOTHING/i);
});

test('fails rather than accepting a conflicting normalized database row', async () => {
  const commands = [];
  const client = {
    async query(sql) {
      commands.push(sql.trim());
      if (/SELECT raw_legacy, source_updated_at FROM legacy_import_snapshots/.test(sql)) return { rows: [] };
      if (/SELECT legacy_feedback_id, raw_legacy FROM feedback_submissions/.test(sql)) return { rows: [] };
      if (/INSERT INTO initiatives/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    }
  };

  await assert.rejects(
    legacyImport.importLegacyData({ client, payload, snapshotId: 'snapshot-conflict' }),
    /conflicting existing initiative 7/
  );
  assert.equal(commands.at(-1), 'ROLLBACK');
});

test('rolls back rather than overwriting conflicting legacy data', async () => {
  const commands = [];
  const client = {
    async query(sql, params = []) {
      commands.push(sql.trim());
      if (/SELECT raw_legacy, source_updated_at FROM legacy_import_snapshots/.test(sql)) return { rows: [] };
      if (/SELECT legacy_feedback_id, raw_legacy FROM feedback_submissions/.test(sql)) {
        return { rows: [{ legacy_feedback_id: '101', raw_legacy: { id: 101, notes: 'different' } }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };

  await assert.rejects(
    legacyImport.importLegacyData?.({ client, payload, snapshotId: 'snapshot-2' }),
    /conflicting existing legacy feedback 101/
  );
  assert.equal(commands[0], 'BEGIN');
  assert.equal(commands.at(-1), 'ROLLBACK');
  assert.equal(commands.includes('COMMIT'), false);
});

test('refuses import replay after any canonical merge before reading or writing import rows', async () => {
  const commands = [];
  const client = {
    async query(sql) {
      commands.push(sql.trim());
      if (/SELECT EXISTS[\s\S]*merged_into_id IS NOT NULL/.test(sql)) return { rows: [{ has_merges: true }] };
      return { rows: [], rowCount: 1 };
    }
  };

  await assert.rejects(
    legacyImport.importLegacyData({ client, payload, snapshotId: 'post-merge' }),
    /legacy import refused: canonical merges already exist/i
  );
  assert.ok(commands.findIndex(sql => /pg_advisory_xact_lock/.test(sql)) < commands.findIndex(sql => /SELECT EXISTS/.test(sql)));
  assert.equal(commands.some(sql => /SELECT raw_legacy/.test(sql)), false);
  assert.equal(commands.at(-1), 'ROLLBACK');
});
