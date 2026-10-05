const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  repairPreCutoverSourceDrift, summarizeRepairTargets, EXPECTED_REPAIRED_IDS, UNASSIGNED_EMPTY_INITIATIVE_IDS
} = require('../scripts/repair-pre-cutover-source-drift');

const donald = EXPECTED_REPAIRED_IDS.map((id, index) => ({
  id, initiativeId: '1', providerName: 'Donald Lefevre', notes: `Feedback #${index + 1}`
}));
const uat = Array.from({ length: 43 }, (_, index) => ({
  id: `mulfm1hz${String(index).padStart(11, 'x')}`, initiativeId: '1', providerName: 'Veneet Vishal', notes: `UAT-${index + 1}`
}));
const georg = [{ id: 'muf9tzrym1onx4agx5r', initiativeId: '1', providerName: 'Georg Hörning', notes: 'Org62 icon' }];
const unassigned = UNASSIGNED_EMPTY_INITIATIVE_IDS.map(id => ({ id, initiativeId: '', providerName: 'Daniela Valverde' }));
const payload = {
  initiatives: [{ id: '1', name: 'SolutionIQ' }],
  feedback: [...donald, ...uat, ...georg, ...unassigned],
  closedLoop: {}
};

test('repair target inventory matches the reviewed 20+44+5 source set', () => {
  const targets = summarizeRepairTargets(payload);
  assert.deepEqual(targets.repaired, EXPECTED_REPAIRED_IDS);
  assert.equal(targets.missing.length, 44);
  assert.deepEqual(targets.unassigned, UNASSIGNED_EMPTY_INITIATIVE_IDS);
});

test('repair refuses a completed cutover or a changed source inventory', async () => {
  assert.throws(() => summarizeRepairTargets({ feedback: [] }), /Donald Lefevre source row/);
  const client = {
    async query(sql) {
      if (/FROM canonical_cutover_state/.test(sql)) return { rows: [{
        stage: 'legacy_read_only', initial_cutover_completed_at: '2026-01-01T00:00:00Z', baseline_source_payload_hash: 'abc'
      }] };
      if (/FROM app_data/.test(sql)) return { rows: [{ payload, updated_at: '2026-10-05T16:33:33.815Z' }] };
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(repairPreCutoverSourceDrift({ pool: { async connect() { return client; } } }),
    /initial cutover provenance already exists/);
});

test('repair refuses to run unless the barrier is still pre-activation', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      if (/FROM canonical_cutover_state/.test(sql)) return { rows: [{ stage: 'canonical_active' }] };
      if (/FROM app_data/.test(sql)) return { rows: [{ payload, updated_at: '2026-10-05T16:33:33.815Z' }] };
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(repairPreCutoverSourceDrift({ pool: { async connect() { return client; } } }),
    /expected legacy_read_only/);
  assert.equal(queries.includes('ROLLBACK'), true);
});

test('package exposes an explicit operator repair command that is not on the release path', () => {
  const pkg = require('../package.json');
  const procfile = fs.readFileSync(path.join(__dirname, '..', 'Procfile'), 'utf8');
  assert.equal(pkg.scripts['cutover:repair-pre'], 'node scripts/repair-pre-cutover-source-drift.js');
  assert.doesNotMatch(procfile, /repair-pre/);
  const runbook = fs.readFileSync(path.join(__dirname, '..', '.agents/artifacts/canonical-cutover-runbook.md'), 'utf8');
  assert.match(runbook, /npm run cutover:repair-pre/);
  assert.match(runbook, /20 Donald Lefevre/);
  assert.match(runbook, /44 later source rows/);
  assert.match(runbook, /empty `raw_legacy.initiativeId`/);
  assert.match(runbook, /empty-string `initiativeId`/);
});
