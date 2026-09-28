const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { checkCanonicalIntegrity, hashLegacySourcePayload, parityFailureMessage } = require('../scripts/activate-canonical-cutover');
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

test('integrity permits only alias-proven cross-initiative submission reparenting', async () => {
  let sql;
  const client = { async query(value) { sql = String(value); return { rows: [{
    orphan_submissions: '0', submission_initiative_mismatches: '0', action_parent_mismatches: '0',
    loop_parent_mismatches: '0', missing_merge_winners: '0'
  }] }; } };
  await checkCanonicalIntegrity(client);
  assert.match(sql, /canonical_feedback_aliases/);
  assert.match(sql, /source\.id=fs\.legacy_feedback_id/);
  assert.match(sql, /chain\.id=fs\.canonical_feedback_id/);
  assert.match(sql, /fs\.initiative_id IS DISTINCT FROM[\s\S]*cf\.initiative_id/);
});

test('integrity resolves bounded alias chains to the exact current submission parent', async () => {
  const cases = [
    { aliases: { a: 'c' }, expected: 0 },
    { aliases: { a: 'b', b: 'c' }, expected: 0 },
    { aliases: { a: 'other' }, expected: 1 },
    { aliases: {}, parent: 'a', expected: 1 },
    { aliases: { a: 'b', b: 'a' }, expected: 1 },
    { aliases: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`a${index}`, index === 32 ? 'c' : `a${index + 1}`])), start: 'a0', expected: 1 },
    { aliases: { a: 'missing' }, expected: 1 }
  ];
  for (const fixture of cases) {
    const client = { async query(sql) {
      const text = String(sql);
      assert.match(text, /WITH RECURSIVE alias_chain/);
      assert.match(text, /depth < 32/);
      assert.match(text, /ANY\s*\(.*path\)/s);
      let current = fixture.start || 'a';
      const path = new Set([current]);
      let resolved = null;
      let traversed = false;
      for (let depth = 0; depth <= 32; depth += 1) {
        const next = fixture.aliases[current];
        if (!next) { resolved = traversed && current !== 'missing' ? current : null; break; }
        if (depth === 32 || path.has(next)) break;
        path.add(next); current = next; traversed = true;
      }
      return { rows: [{ orphan_submissions: '0', submission_initiative_mismatches: String(resolved === (fixture.parent || 'c') ? 0 : 1),
        action_parent_mismatches: '0', loop_parent_mismatches: '0', missing_merge_winners: '0' }] };
    } };
    if (fixture.expected === 0) assert.equal((await checkCanonicalIntegrity(client)).submission_initiative_mismatches, 0);
    else await assert.rejects(checkCanonicalIntegrity(client), /submission_initiative_mismatches":1/);
  }
});

test('activation parity errors are bounded summaries with optional detailed report kept out of the exception', () => {
  const report = {
    legacyCount: 476, canonicalCount: 476,
    mismatches: Array.from({ length: 476 }, (_, index) => ({ id: `f${index}`, expected: { text: 'x'.repeat(1000) }, actual: {} })),
    relationshipErrors: Array.from({ length: 20 }, (_, index) => ({ id: `r${index}`, error: 'initiative relationship mismatch' })),
    missingIds: [], extraIds: [], duplicateLegacyIds: [], duplicateCanonicalIds: [], initiativeMismatches: [{ id: '1' }], extraInitiativeIds: []
  };
  const message = parityFailureMessage(report);
  assert.match(message, /legacyCount=476/);
  assert.match(message, /mismatches=476/);
  assert.match(message, /relationshipErrors=20/);
  assert.match(message, /sampleIds=/);
  assert.ok(message.length < 1000);
  assert.doesNotMatch(message, /expected|actual|xxxx/);
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
