SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE feedback_submissions
  ADD COLUMN submission_attributes JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE canonical_feedback ADD COLUMN retired_at TIMESTAMPTZ;

CREATE TABLE canonical_cutover_state (
  name TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('legacy_read_only', 'canonical_active')),
  source_payload_hash TEXT,
  source_updated_at TIMESTAMPTZ,
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'::JSONB
);

UPDATE feedback_submissions
SET submission_attributes = jsonb_strip_nulls(jsonb_build_object(
  'format', raw_legacy->'format',
  'frictionPoints', raw_legacy->'frictionPoints', 'toolsMentioned', raw_legacy->'toolsMentioned',
  'workarounds', raw_legacy->'workarounds', 'dealImpact', raw_legacy->'dealImpact',
  'quotes', raw_legacy->'quotes', 'notes', raw_legacy->'notes'
))
WHERE raw_legacy IS NOT NULL AND submission_attributes = '{}'::JSONB;

ALTER TABLE action_items
  ALTER COLUMN legacy_snapshot_id DROP NOT NULL,
  ALTER COLUMN original_ordinal DROP NOT NULL,
  ALTER COLUMN raw_legacy DROP NOT NULL,
  ADD COLUMN idempotency_key TEXT;

CREATE INDEX feedback_submissions_active_canonical_idx
  ON feedback_submissions (canonical_feedback_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX feedback_submissions_active_legacy_idx
  ON feedback_submissions (legacy_feedback_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX action_items_submission_idempotency_idx
  ON action_items (feedback_submission_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE VIEW canonical_feedback_status AS
SELECT cf.id AS canonical_feedback_id,
  CASE WHEN cf.merged_into_id IS NULL AND cf.retired_at IS NULL AND EXISTS (
    SELECT 1 FROM feedback_submissions fs
    WHERE fs.canonical_feedback_id = cf.id AND fs.deleted_at IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM feedback_submissions fs
    LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
    WHERE fs.canonical_feedback_id = cf.id AND fs.deleted_at IS NULL
      AND COALESCE(cl.closed, FALSE) = FALSE
  ) THEN TRUE ELSE FALSE END AS closed
FROM canonical_feedback cf;
