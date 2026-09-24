const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.join(__dirname, '..', 'migrations', '001_canonical_feedback.sql');
const canonicalApiMigrationPath = path.join(__dirname, '..', 'migrations', '002_canonical_api.sql');
const historicalMergeMigrationPath = path.join(__dirname, '..', 'migrations', '003_historical_merge_review.sql');
const groupedMergeMigrationPath = path.join(__dirname, '..', 'migrations', '004_grouped_merge_review.sql');

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

test('canonical API migration permits native rows and adds idempotency and pagination support', () => {
  assert.equal(fs.existsSync(canonicalApiMigrationPath), true, 'missing canonical API migration');
  const sql = fs.readFileSync(canonicalApiMigrationPath, 'utf8');

  for (const column of ['legacy_snapshot_id', 'legacy_feedback_id', 'original_ordinal', 'raw_legacy']) {
    assert.match(sql, new RegExp(`ALTER COLUMN ${column} DROP NOT NULL`, 'i'));
  }
  assert.match(sql, /CREATE TABLE api_idempotency/i);
  assert.match(sql, /UNIQUE\s*\(operation,\s*idempotency_key\)/i);
  assert.match(sql, /request_hash\s+TEXT\s+NOT NULL/i);
  assert.match(sql, /response\s+JSONB\s+NOT NULL/i);
  assert.match(sql, /expires_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s*\(NOW\(\)\s*\+\s*INTERVAL\s+'24 hours'\)/i);
  assert.match(sql, /CREATE INDEX api_idempotency_expires_at_idx\s+ON api_idempotency\s*\(expires_at\)/i);
  assert.match(sql, /ADD CONSTRAINT feedback_submissions_id_canonical_unique\s+UNIQUE\s*\(id,\s*canonical_feedback_id\)/i);
  assert.match(sql, /FOREIGN KEY\s*\(feedback_submission_id,\s*canonical_feedback_id\)\s*REFERENCES feedback_submissions\s*\(id,\s*canonical_feedback_id\)/i);
  assert.match(sql, /canonical_feedback\s*\(created_at\s+DESC,\s*id\s+DESC\)/i);
  assert.match(sql, /feedback_submissions\s*\(canonical_feedback_id,\s*created_at/i);
  assert.match(sql, /OLD\.raw_legacy IS NOT NULL[\s\S]*OLD\.raw_legacy IS DISTINCT FROM NEW\.raw_legacy/i);
});

test('historical merge migration adds active search, review, aliases, and immutable audit relationships', () => {
  assert.equal(fs.existsSync(historicalMergeMigrationPath), true, 'missing historical merge migration');
  const sql = fs.readFileSync(historicalMergeMigrationPath, 'utf8');

  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm/i);
  assert.match(sql, /ADD COLUMN merged_into_id TEXT REFERENCES canonical_feedback\s*\(id\)/i);
  assert.match(sql, /ADD COLUMN merged_at TIMESTAMPTZ/i);
  assert.match(sql, /normalized_text TEXT GENERATED ALWAYS AS[\s\S]*regexp_replace[\s\S]*STORED/i);
  assert.match(sql, /search_vector TSVECTOR GENERATED ALWAYS AS[\s\S]*to_tsvector[\s\S]*STORED/i);
  assert.match(sql, /USING GIN\s*\(normalized_text gin_trgm_ops\)/i);
  assert.match(sql, /USING GIN\s*\(search_vector\)/i);
  assert.match(sql, /WHERE merged_into_id IS NULL/i);

  for (const constraint of ['closed_loops_submission_canonical_fk', 'action_items_submission_canonical_fk']) {
    assert.match(sql, new RegExp(`ADD CONSTRAINT ${constraint}[\\s\\S]*FOREIGN KEY \\(feedback_submission_id, canonical_feedback_id\\)[\\s\\S]*DEFERRABLE INITIALLY IMMEDIATE`, 'i'));
  }
  assert.match(sql, /pair_low TEXT GENERATED ALWAYS AS\s*\(LEAST\s*\(canonical_feedback_id, candidate_feedback_id\)\) STORED/i);
  assert.match(sql, /pair_high TEXT GENERATED ALWAYS AS\s*\(GREATEST\s*\(canonical_feedback_id, candidate_feedback_id\)\) STORED/i);
  assert.match(sql, /FROM pg_constraint constraint_row[\s\S]*constraint_row\.contype = 'u'[\s\S]*canonical_feedback_id[\s\S]*candidate_feedback_id[\s\S]*format\('ALTER TABLE duplicate_candidates DROP CONSTRAINT %I'/i);
  assert.match(sql, /UNIQUE\s*\(pair_low, pair_high\)/i);
  assert.match(sql, /CHECK\s*\(status IN \('pending', 'rejected', 'confirmed', 'superseded'\)\)/i);
  for (const column of ['decided_at', 'decided_by', 'decision_reason', 'merge_operation_id']) assert.match(sql, new RegExp(`ADD COLUMN ${column}\\b`, 'i'));

  assert.match(sql, /CREATE TABLE canonical_merge_operations/i);
  assert.match(sql, /candidate_id TEXT NOT NULL REFERENCES duplicate_candidates/i);
  assert.match(sql, /winner_id TEXT NOT NULL REFERENCES canonical_feedback/i);
  assert.match(sql, /loser_id TEXT NOT NULL REFERENCES canonical_feedback/i);
  assert.match(sql, /moved_submission_count INTEGER NOT NULL/i);
  assert.match(sql, /moved_action_item_count INTEGER NOT NULL/i);
  assert.match(sql, /moved_closed_loop_count INTEGER NOT NULL/i);
  assert.match(sql, /evidence_snapshot JSONB NOT NULL/i);
  assert.match(sql, /request_hash TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /CREATE TABLE canonical_feedback_aliases/i);
  assert.match(sql, /alias_id TEXT PRIMARY KEY REFERENCES canonical_feedback/i);
  assert.match(sql, /canonical_feedback_id TEXT NOT NULL REFERENCES canonical_feedback/i);
  assert.match(sql, /merge_operation_id TEXT NOT NULL REFERENCES canonical_merge_operations/i);
  assert.match(sql, /canonical_summaries[\s\S]*ADD COLUMN stale BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(sql, /DO \$\$[\s\S]*invalid duplicate candidate statuses[\s\S]*reverse duplicate candidate pairs[\s\S]*NULL duplicate candidate scores/i);
  assert.match(sql, /ALTER COLUMN score SET NOT NULL/i);
  assert.match(sql, /feedback_submissions[\s\S]*ADD COLUMN original_text TEXT/i);
  assert.match(sql, /UPDATE feedback_submissions[\s\S]*SET original_text = cf\.canonical_text[\s\S]*original_text IS NULL[\s\S]*legacy_feedback_id IS NOT NULL/i);
  assert.match(sql, /canonical_merge_operations_immutable/i);
  assert.match(sql, /canonical_feedback_aliases_immutable/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON canonical_merge_operations/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON canonical_feedback_aliases/i);
  assert.match(sql, /canonical alias target must be active/i);
});

test('historical merge migration bounds locks and preflights existing composite FK mismatches', () => {
  const sql = fs.readFileSync(historicalMergeMigrationPath, 'utf8');
  const preflightEnd = sql.indexOf('ALTER TABLE closed_loops DROP CONSTRAINT');
  const preflight = sql.slice(0, preflightEnd);

  assert.match(sql, /SET LOCAL lock_timeout\s*=\s*'10s'/i);
  assert.match(sql, /SET LOCAL statement_timeout\s*=\s*'60s'/i);
  assert.match(preflight, /FROM action_items ai\s+JOIN feedback_submissions fs\s+ON fs\.id\s*=\s*ai\.feedback_submission_id[\s\S]*ai\.canonical_feedback_id IS DISTINCT FROM fs\.canonical_feedback_id/i);
  assert.match(preflight, /migration 003 preflight failed: action_items canonical feedback does not match its submission/i);
  assert.match(preflight, /FROM closed_loops cl\s+JOIN feedback_submissions fs\s+ON fs\.id\s*=\s*cl\.feedback_submission_id[\s\S]*cl\.canonical_feedback_id IS DISTINCT FROM fs\.canonical_feedback_id/i);
  assert.match(preflight, /migration 003 preflight failed: closed_loops canonical feedback does not match its submission/i);
  assert.match(sql, /475 historical records[\s\S]*bounded maintenance window/i);
});

test('grouped merge migration adds immutable batches and candidate transition events without changing statuses', () => {
  assert.equal(fs.existsSync(groupedMergeMigrationPath), true, 'missing grouped merge migration');
  const sql = fs.readFileSync(groupedMergeMigrationPath, 'utf8');
  assert.match(sql, /SET LOCAL lock_timeout\s*=\s*'10s'/i);
  assert.match(sql, /SET LOCAL statement_timeout\s*=\s*'60s'/i);
  assert.match(sql, /CREATE TABLE duplicate_candidate_events[\s\S]*candidate_id[\s\S]*from_status[\s\S]*to_status[\s\S]*reason_code[\s\S]*evidence_snapshot JSONB NOT NULL[\s\S]*merge_operation_id TEXT REFERENCES canonical_merge_operations[\s\S]*merge_batch_id/i);
  assert.match(sql, /CHECK\s*\(NOT\s*\(merge_operation_id IS NOT NULL AND merge_batch_id IS NOT NULL\)\)/i);
  assert.match(sql, /CREATE TABLE canonical_merge_batches[\s\S]*initiative_id[\s\S]*winner_id[\s\S]*member_ids JSONB NOT NULL[\s\S]*evidence_snapshot JSONB NOT NULL[\s\S]*request_hash TEXT NOT NULL UNIQUE[\s\S]*moved_submission_count/i);
  assert.match(sql, /CREATE TABLE canonical_merge_batch_members[\s\S]*merge_batch_id[\s\S]*winner_id[\s\S]*loser_id[\s\S]*supporting_candidate_ids JSONB[\s\S]*moved_submission_count[\s\S]*evidence_snapshot/i);
  assert.match(sql, /canonical_feedback_aliases[\s\S]*ALTER COLUMN merge_operation_id DROP NOT NULL[\s\S]*ADD COLUMN merge_batch_member_id[\s\S]*CHECK[\s\S]*merge_operation_id IS NOT NULL[\s\S]*merge_batch_member_id IS NOT NULL/i);
  assert.match(sql, /duplicate_candidates[\s\S]*ADD COLUMN decision_batch_id[\s\S]*REFERENCES canonical_merge_batches/i);
  assert.match(sql, /legacy_confirmed[\s\S]*dc\.merge_operation_id[\s\S]*canonical_merge_operations/i);
  assert.match(sql, /'pending',\s*'confirmed',\s*'legacy_confirmed'/i);
  assert.match(sql, /legacy_system_merge_overlap[\s\S]*dc\.status = 'superseded'[\s\S]*dc\.decision_reason = 'canonical feedback merged'/i);
  assert.match(sql, /'pending',\s*'superseded',\s*'legacy_system_merge_overlap'/i);
  assert.match(sql, /superseded_lineage[\s\S]*operation\.loser_id IN \(dc\.canonical_feedback_id, dc\.candidate_feedback_id\)[\s\S]*HAVING COUNT\(\*\) = 1[\s\S]*COALESCE\(dc\.merge_operation_id, lineage\.merge_operation_id\)/i);
  assert.doesNotMatch(sql, /WITH eligible|endpoint_ranks|endpoint_rank <=|normalized_text %|merged_into_id IS NULL/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON duplicate_candidate_events/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON canonical_merge_batches/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON canonical_merge_batch_members/i);
  assert.doesNotMatch(sql, /UPDATE\s+duplicate_candidates\s+SET\s+status/i);
});
