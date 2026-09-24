const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { hashLegacySourcePayload } = require('../scripts/activate-canonical-cutover');
const { prepareCanonicalCutover } = require('../scripts/prepare-canonical-cutover');

const root = path.join(__dirname, '..');

test('release only migrates and ensures the legacy_read_only barrier', () => {
  const pkg = require('../package.json');
  const procfile = fs.readFileSync(path.join(root, 'Procfile'), 'utf8');
  assert.equal(pkg.scripts['cutover:prepare'], 'node scripts/prepare-canonical-cutover.js');
  assert.equal(pkg.scripts['cutover:activate'], 'node scripts/activate-canonical-cutover.js');
  assert.match(procfile, /release: npm run cutover:prepare/);
  assert.doesNotMatch(procfile, /activate/);
  const prepare = fs.readFileSync(path.join(root, 'scripts/prepare-canonical-cutover.js'), 'utf8');
  assert.match(prepare, /runMigrations/);
  assert.match(prepare, /legacy_read_only/);
  assert.match(prepare, /ON CONFLICT \(name\) DO UPDATE/);
  assert.doesNotMatch(prepare, /source_payload_hash\s*=\s*NULL/);
  assert.doesNotMatch(prepare, /baseline_source_payload_hash\s*=\s*NULL/);
  assert.match(prepare, /pg_advisory_xact_lock/);
  assert.match(prepare, /stage === 'canonical_active'[\s\S]*source_payload_hash/);
  assert.match(prepare, /hashLegacySourcePayload[\s\S]*!==[\s\S]*source_payload_hash/);
  assert.match(prepare, /explicit operator migration required/i);
  assert.doesNotMatch(prepare, /baseline_source_payload_hash=\$1[\s\S]*hashLegacySourcePayload\(source\.rows\[0\]\.payload\)/);
  assert.match(prepare, /stage_changed_at=NOW\(\)/);
  assert.doesNotMatch(prepare, /reconcileFieldInputs|checkParity/);
  assert.equal(fs.existsSync(path.join(root, 'scripts/release-canonical-cutover.js')), false);
});

test('manual activation holds one transaction and lock through reconciliation, parity, and marker', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/activate-canonical-cutover.js'), 'utf8');
  assert.match(script, /BEGIN/);
  assert.match(script, /pg_advisory_xact_lock/);
  assert.match(script, /app_data[\s\S]*FOR UPDATE/);
  assert.match(script, /reconcileFieldInputs[\s\S]*checkParity[\s\S]*canonical_active/);
  assert.equal((script.match(/COMMIT/g) || []).length, 1);
  assert.match(script, /initialCutoverCompletedAt/);
  assert.match(script, /activationMode/);
  assert.match(script, /baselineSourcePayloadHash/);
  assert.match(script, /source drift/i);
  assert.match(script, /checkCanonicalIntegrity/);
});

test('repeat activation is integrity-only and never replays the frozen legacy source', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/activate-canonical-cutover.js'), 'utf8');
  const branchStart = script.indexOf('if (initialCutoverCompletedAt)');
  const repeatBranch = script.slice(branchStart, script.indexOf('} else {', branchStart));
  assert.doesNotMatch(repeatBranch, /reconcileFieldInputs|checkParity/);
  assert.ok(script.indexOf('checkCanonicalIntegrity(client)', branchStart) > script.indexOf('} else {', branchStart));
});

test('durable source hash covers legacy-owned source only so approved sidecars do not create false drift', () => {
  const legacy = { initiatives: [{ id: 'i1' }], feedback: [{ id: 'f1' }], closedLoop: { f1: { closed: false } } };
  assert.equal(hashLegacySourcePayload({ ...legacy, timelineHistory: [{ id: 'one' }], slackChannelId: 'C1' }),
    hashLegacySourcePayload({ ...legacy, timelineHistory: [{ id: 'two' }], slackChannelId: 'C2' }));
  assert.notEqual(hashLegacySourcePayload(legacy), hashLegacySourcePayload({ ...legacy, feedback: [] }));
});

test('prepare rolls back before the barrier when an active pre-006 source marker is missing or mismatched', async () => {
  for (const sourcePayloadHash of [null, 'different']) {
    const queries = [];
    const client = {
      async query(sql) {
        queries.push(String(sql));
        if (/SELECT stage,stage_changed_at,source_payload_hash/.test(sql)) return { rows: [{
          stage: 'canonical_active', stage_changed_at: '2026-01-01T00:00:00Z', source_payload_hash: sourcePayloadHash,
          initial_cutover_completed_at: null, baseline_source_payload_hash: null
        }] };
        if (/SELECT payload FROM app_data/.test(sql)) return { rows: [{ payload: { initiatives: [], feedback: [], closedLoop: {} } }] };
        return { rows: [] };
      },
      release() {}
    };
    const pool = { async connect() { return client; } };
    await assert.rejects(prepareCanonicalCutover({ pool, runMigrationsFn: async () => {} }), /explicit operator migration required/i);
    assert.equal(queries.includes('ROLLBACK'), true);
    assert.equal(queries.some(sql => /SET stage='legacy_read_only'/.test(sql)), false);
  }
});

test('runbook documents exact two-stage commands and no automatic activation', () => {
  const runbook = fs.readFileSync(path.join(root, '.agents/artifacts/canonical-cutover-runbook.md'), 'utf8');
  assert.match(runbook, /npm run cutover:prepare/);
  assert.match(runbook, /npm run cutover:activate/);
  assert.match(runbook, /must not auto-activate/i);
  assert.match(runbook, /every deploy/i);
  assert.match(runbook, /sourcePayloadHash/);
  assert.match(runbook, /integrity-only/i);
  assert.match(runbook, /source drift/i);
  assert.match(runbook, /emergency/i);
  assert.match(runbook, /SELECT stage, source_payload_hash, baseline_source_payload_hash/i);
  assert.match(runbook, /BEGIN;[\s\S]*UPDATE canonical_cutover_state[\s\S]*COMMIT;/i);
  assert.match(runbook, /operator decision/i);
  assert.match(runbook, /never use the current app_data hash as the baseline/i);
});
