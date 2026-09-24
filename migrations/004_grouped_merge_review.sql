SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE canonical_merge_batches (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives (id) ON DELETE RESTRICT,
  winner_id TEXT NOT NULL REFERENCES canonical_feedback (id) ON DELETE RESTRICT,
  member_ids JSONB NOT NULL,
  evidence_snapshot JSONB NOT NULL,
  reason TEXT NOT NULL,
  actor_label TEXT,
  request_hash TEXT NOT NULL UNIQUE,
  moved_submission_count INTEGER NOT NULL CHECK (moved_submission_count >= 0),
  moved_action_item_count INTEGER NOT NULL CHECK (moved_action_item_count >= 0),
  moved_closed_loop_count INTEGER NOT NULL CHECK (moved_closed_loop_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE canonical_merge_batch_members (
  id TEXT PRIMARY KEY,
  merge_batch_id TEXT NOT NULL REFERENCES canonical_merge_batches (id) ON DELETE RESTRICT,
  winner_id TEXT NOT NULL REFERENCES canonical_feedback (id) ON DELETE RESTRICT,
  loser_id TEXT NOT NULL REFERENCES canonical_feedback (id) ON DELETE RESTRICT,
  supporting_candidate_ids JSONB NOT NULL,
  moved_submission_count INTEGER NOT NULL CHECK (moved_submission_count >= 0),
  moved_action_item_count INTEGER NOT NULL CHECK (moved_action_item_count >= 0),
  moved_closed_loop_count INTEGER NOT NULL CHECK (moved_closed_loop_count >= 0),
  evidence_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (merge_batch_id, loser_id),
  CHECK (winner_id <> loser_id)
);

ALTER TABLE canonical_feedback_aliases
  ALTER COLUMN merge_operation_id DROP NOT NULL,
  ADD COLUMN merge_batch_member_id TEXT REFERENCES canonical_merge_batch_members (id) ON DELETE RESTRICT,
  ADD CONSTRAINT canonical_feedback_alias_lineage_check CHECK (
    (merge_operation_id IS NOT NULL AND merge_batch_member_id IS NULL)
    OR (merge_operation_id IS NULL AND merge_batch_member_id IS NOT NULL)
  );

ALTER TABLE duplicate_candidates
  ADD COLUMN decision_batch_id TEXT REFERENCES canonical_merge_batches (id) ON DELETE RESTRICT;

CREATE TABLE duplicate_candidate_events (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES duplicate_candidates (id) ON DELETE RESTRICT,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  evidence_snapshot JSONB NOT NULL,
  merge_operation_id TEXT REFERENCES canonical_merge_operations (id) ON DELETE RESTRICT,
  merge_batch_id TEXT REFERENCES canonical_merge_batches (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NOT (merge_operation_id IS NOT NULL AND merge_batch_id IS NOT NULL))
);

CREATE INDEX duplicate_candidate_events_candidate_idx
  ON duplicate_candidate_events (candidate_id, created_at, id);

INSERT INTO duplicate_candidate_events
  (id, candidate_id, from_status, to_status, reason_code, evidence_snapshot, merge_operation_id, created_at)
SELECT 'candidate-event:' || md5(dc.id || ':legacy_confirmed'), dc.id,
  'pending', 'confirmed', 'legacy_confirmed',
  jsonb_build_object('status', dc.status, 'version', dc.version, 'score', dc.score,
    'evidence', dc.evidence, 'decisionReason', dc.decision_reason,
    'decidedAt', dc.decided_at, 'decidedBy', dc.decided_by,
    'mergeOperation', jsonb_build_object('id', operation.id, 'winnerId', operation.winner_id,
      'loserId', operation.loser_id, 'evidence', operation.evidence_snapshot)),
  dc.merge_operation_id,
  COALESCE(dc.decided_at, dc.updated_at, NOW())
FROM duplicate_candidates dc
JOIN canonical_merge_operations operation ON operation.id = dc.merge_operation_id
WHERE dc.status = 'confirmed';

WITH superseded_lineage AS (
  SELECT dc.id AS candidate_id, MIN(operation.id) AS merge_operation_id
  FROM duplicate_candidates dc
  JOIN canonical_merge_operations operation
    ON operation.loser_id IN (dc.canonical_feedback_id, dc.candidate_feedback_id)
  WHERE dc.status = 'superseded'
    AND dc.decision_reason = 'canonical feedback merged'
  GROUP BY dc.id
  HAVING COUNT(*) = 1
)
INSERT INTO duplicate_candidate_events
  (id, candidate_id, from_status, to_status, reason_code, evidence_snapshot, merge_operation_id, created_at)
SELECT 'candidate-event:' || md5(dc.id || ':legacy_system_merge_overlap'), dc.id,
  'pending', 'superseded', 'legacy_system_merge_overlap',
  jsonb_build_object('status', dc.status, 'version', dc.version, 'score', dc.score,
    'evidence', dc.evidence, 'decisionReason', dc.decision_reason,
    'decidedAt', dc.decided_at, 'decidedBy', dc.decided_by),
  COALESCE(dc.merge_operation_id, lineage.merge_operation_id),
  COALESCE(dc.decided_at, dc.updated_at, NOW())
FROM duplicate_candidates dc
LEFT JOIN superseded_lineage lineage ON lineage.candidate_id = dc.id
WHERE dc.status = 'superseded'
  AND dc.decision_reason = 'canonical feedback merged';

CREATE TRIGGER canonical_merge_batches_immutable
BEFORE UPDATE OR DELETE ON canonical_merge_batches
FOR EACH ROW EXECUTE FUNCTION reject_merge_audit_changes();

CREATE TRIGGER canonical_merge_batch_members_immutable
BEFORE UPDATE OR DELETE ON canonical_merge_batch_members
FOR EACH ROW EXECUTE FUNCTION reject_merge_audit_changes();

CREATE TRIGGER duplicate_candidate_events_immutable
BEFORE UPDATE OR DELETE ON duplicate_candidate_events
FOR EACH ROW EXECUTE FUNCTION reject_merge_audit_changes();
