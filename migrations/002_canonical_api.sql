ALTER TABLE feedback_submissions
  ALTER COLUMN legacy_snapshot_id DROP NOT NULL,
  ALTER COLUMN legacy_feedback_id DROP NOT NULL,
  ALTER COLUMN original_ordinal DROP NOT NULL,
  ALTER COLUMN raw_legacy DROP NOT NULL;

ALTER TABLE action_items
  ALTER COLUMN legacy_snapshot_id DROP NOT NULL,
  ALTER COLUMN original_ordinal DROP NOT NULL,
  ALTER COLUMN raw_legacy DROP NOT NULL;

ALTER TABLE closed_loops
  ALTER COLUMN legacy_snapshot_id DROP NOT NULL,
  ALTER COLUMN raw_legacy DROP NOT NULL;

ALTER TABLE feedback_submissions
  ADD CONSTRAINT feedback_submissions_id_canonical_unique UNIQUE (id, canonical_feedback_id);

ALTER TABLE closed_loops
  ADD CONSTRAINT closed_loops_submission_canonical_fk
  FOREIGN KEY (feedback_submission_id, canonical_feedback_id)
  REFERENCES feedback_submissions (id, canonical_feedback_id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION preserve_feedback_submission_legacy_data() RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.raw_legacy IS NOT NULL AND OLD.raw_legacy IS DISTINCT FROM NEW.raw_legacy)
    OR (OLD.legacy_feedback_id IS NOT NULL AND OLD.legacy_feedback_id IS DISTINCT FROM NEW.legacy_feedback_id)
    OR (OLD.original_ordinal IS NOT NULL AND OLD.original_ordinal IS DISTINCT FROM NEW.original_ordinal)
    OR (OLD.legacy_snapshot_id IS NOT NULL AND OLD.legacy_snapshot_id IS DISTINCT FROM NEW.legacy_snapshot_id) THEN
    RAISE EXCEPTION 'feedback submission legacy data is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE api_idempotency (
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  UNIQUE (operation, idempotency_key)
);

CREATE INDEX api_idempotency_expires_at_idx ON api_idempotency (expires_at);

CREATE INDEX canonical_feedback_created_id_idx
  ON canonical_feedback (created_at DESC, id DESC);
CREATE INDEX canonical_feedback_initiative_created_id_idx
  ON canonical_feedback (initiative_id, created_at DESC, id DESC);
CREATE INDEX feedback_submissions_canonical_created_idx
  ON feedback_submissions (canonical_feedback_id, created_at, id);
