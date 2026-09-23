const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.join(__dirname, '..', 'migrations', '001_canonical_feedback.sql');

test('canonical migration defines the audited schema foundation', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const requiredTables = [
    'legacy_import_snapshots',
    'dedup_cache',
    'initiatives',
    'initiative_enablement',
    'canonical_feedback',
    'feedback_submissions',
    'action_items',
    'closed_loops',
    'duplicate_candidates',
    'canonical_summaries',
    'canonical_summary_revisions',
    'canonical_summary_evidence'
  ];

  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table}\\b`, 'i'), `missing ${table}`);
  }
  assert.doesNotMatch(sql, /(?:ALTER|DROP|TRUNCATE|DELETE\s+FROM)\s+(?:TABLE\s+)?app_data/i);
  assert.match(sql, /legacy_import_snapshots[\s\S]*raw_legacy\s+JSONB\s+NOT NULL/i);
  assert.match(sql, /feedback_submissions[\s\S]*raw_legacy\s+JSONB\s+NOT NULL/i);
  assert.match(sql, /feedback_submissions[\s\S]*original_ordinal\s+INTEGER\s+NOT NULL/i);
  assert.match(sql, /feedback_submissions[\s\S]*legacy_feedback_id\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  assert.match(sql, /provider_snapshot\s+JSONB\s+NOT NULL/i);
  assert.match(sql, /source_data\s+JSONB\s+NOT NULL/i);
  assert.match(sql, /submitted_on\s+DATE/i);
  assert.match(sql, /source_created_at\s+TIMESTAMPTZ/i);
  assert.doesNotMatch(sql, /submitted_at\s+TIMESTAMPTZ/i);
  assert.match(sql, /initiative_enablement[\s\S]*enabled_on\s+DATE/i);
  assert.doesNotMatch(sql, /enabled_at\s+TIMESTAMPTZ/i);
  assert.match(sql, /OLD\.raw_legacy\s+IS DISTINCT FROM\s+NEW\.raw_legacy/i);
  assert.match(sql, /BEFORE UPDATE ON feedback_submissions/i);
});

test('moves legacy app_data setup into the explicit migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_data/i);
  assert.match(sql, /ON CONFLICT\s*\(id\)\s*DO NOTHING/i);
  assert.doesNotMatch(server, /CREATE TABLE IF NOT EXISTS app_data/i);
  assert.doesNotMatch(server, /CREATE TABLE IF NOT EXISTS dedup_cache/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dedup_cache/i);
});

test('canonical migration includes relationships, indexes, and version columns', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /REFERENCES initiatives\s*\(id\)/i);
  assert.match(sql, /REFERENCES canonical_feedback\s*\(id\)/i);
  assert.match(sql, /REFERENCES canonical_summaries\s*\(id\)/i);
  assert.match(sql, /REFERENCES canonical_summary_revisions\s*\(id\)/i);
  assert.match(sql, /CREATE INDEX [\s\S]*canonical_feedback/i);
  assert.match(sql, /CREATE INDEX [\s\S]*feedback_submissions/i);
  assert.match(sql, /CREATE INDEX [\s\S]*duplicate_candidates/i);
  assert.ok((sql.match(/\bversion\s+INTEGER\s+NOT NULL/gi) || []).length >= 2);
  assert.match(sql, /CHECK\s*\(candidate_feedback_id\s*<>\s*canonical_feedback_id\)/i);
  assert.match(sql, /initiative_enablement[\s\S]*ou_key\s+TEXT\s+NOT NULL/i);
  assert.match(sql, /UNIQUE\s*\(initiative_id,\s*ou_key\)/i);
  assert.match(sql, /action_items[\s\S]*feedback_submission_id\s+TEXT\s+NOT NULL\s+REFERENCES feedback_submissions/i);
  assert.match(sql, /action_items[\s\S]*original_ordinal\s+INTEGER\s+NOT NULL/i);
  assert.match(sql, /action_items[\s\S]*raw_legacy\s+JSONB\s+NOT NULL/i);
  assert.match(sql, /action_items[\s\S]*legacy_snapshot_id\s+TEXT\s+NOT NULL/i);
  assert.match(sql, /closed_loops[\s\S]*feedback_submission_id\s+TEXT\s+NOT NULL\s+UNIQUE\s+REFERENCES feedback_submissions/i);
  assert.match(sql, /closed_loops[\s\S]*raw_legacy\s+JSONB\s+NOT NULL/i);
  assert.match(sql, /closed_loops[\s\S]*legacy_snapshot_id\s+TEXT\s+NOT NULL/i);
  for (const index of [
    'initiative_enablement_initiative_idx', 'action_items_submission_idx',
    'closed_loops_canonical_idx', 'canonical_summary_evidence_submission_idx'
  ]) assert.match(sql, new RegExp(`CREATE INDEX ${index}\\b`, 'i'));
});

test('closed loops are unique per submission and canonical closure is derived', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const closedLoops = sql.match(/CREATE TABLE closed_loops[\s\S]*?\n\);/i)?.[0] || '';

  assert.match(closedLoops, /feedback_submission_id\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  assert.doesNotMatch(closedLoops, /canonical_feedback_id\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  assert.match(sql, /CREATE VIEW canonical_feedback_status/i);
  assert.match(sql, /EXISTS\s*\([\s\S]*feedback_submissions/i);
  assert.match(sql, /NOT EXISTS\s*\([\s\S]*feedback_submissions[\s\S]*LEFT JOIN closed_loops/i);
  assert.match(sql, /COALESCE\s*\(cl\.closed,\s*FALSE\)\s*=\s*FALSE/i);
  assert.doesNotMatch(sql, /canonical_feedback[\s\S]*?status\s+TEXT\s+NOT NULL\s+DEFAULT\s+'open'/i);
});
