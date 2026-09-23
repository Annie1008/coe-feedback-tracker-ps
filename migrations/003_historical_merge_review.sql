-- This migration covers 475 historical records in a bounded maintenance window.
-- while the transaction-held indexes and foreign keys are created on this small data set.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM duplicate_candidates
    WHERE status IS NULL OR status NOT IN ('pending', 'rejected', 'confirmed', 'superseded')
  ) THEN
    RAISE EXCEPTION 'migration 003 preflight failed: invalid duplicate candidate statuses';
  END IF;
  IF EXISTS (
    SELECT 1 FROM duplicate_candidates a
    JOIN duplicate_candidates b
      ON a.canonical_feedback_id = b.candidate_feedback_id
      AND a.candidate_feedback_id = b.canonical_feedback_id
      AND a.id < b.id
  ) THEN
    RAISE EXCEPTION 'migration 003 preflight failed: reverse duplicate candidate pairs';
  END IF;
  IF EXISTS (SELECT 1 FROM duplicate_candidates WHERE score IS NULL) THEN
    RAISE EXCEPTION 'migration 003 preflight failed: NULL duplicate candidate scores';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM action_items ai
    JOIN feedback_submissions fs ON fs.id = ai.feedback_submission_id
    WHERE ai.canonical_feedback_id IS DISTINCT FROM fs.canonical_feedback_id
  ) THEN
    RAISE EXCEPTION 'migration 003 preflight failed: action_items canonical feedback does not match its submission';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM closed_loops cl
    JOIN feedback_submissions fs ON fs.id = cl.feedback_submission_id
    WHERE cl.canonical_feedback_id IS DISTINCT FROM fs.canonical_feedback_id
  ) THEN
    RAISE EXCEPTION 'migration 003 preflight failed: closed_loops canonical feedback does not match its submission';
  END IF;
END;
$$;

ALTER TABLE canonical_feedback
  ADD COLUMN merged_into_id TEXT REFERENCES canonical_feedback (id) ON DELETE RESTRICT,
  ADD COLUMN merged_at TIMESTAMPTZ,
  ADD COLUMN normalized_text TEXT GENERATED ALWAYS AS
    (lower(regexp_replace(canonical_text, '[^[:alnum:]]+', ' ', 'g'))) STORED,
  ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS
    (to_tsvector('simple', canonical_text)) STORED,
  ADD CONSTRAINT canonical_feedback_merge_state_check
    CHECK ((merged_into_id IS NULL AND merged_at IS NULL) OR (merged_into_id IS NOT NULL AND merged_at IS NOT NULL)),
  ADD CONSTRAINT canonical_feedback_not_self_merged_check CHECK (merged_into_id IS NULL OR merged_into_id <> id);

CREATE INDEX canonical_feedback_initiative_normalized_idx
  ON canonical_feedback (initiative_id, normalized_text);
CREATE INDEX canonical_feedback_normalized_trgm_idx
  ON canonical_feedback USING GIN (normalized_text gin_trgm_ops);
CREATE INDEX canonical_feedback_search_vector_idx
  ON canonical_feedback USING GIN (search_vector);
CREATE INDEX canonical_feedback_active_list_idx
  ON canonical_feedback (initiative_id, created_at DESC, id DESC) WHERE merged_into_id IS NULL;

ALTER TABLE closed_loops DROP CONSTRAINT closed_loops_submission_canonical_fk;
ALTER TABLE closed_loops
  ADD CONSTRAINT closed_loops_submission_canonical_fk
  FOREIGN KEY (feedback_submission_id, canonical_feedback_id)
  REFERENCES feedback_submissions (id, canonical_feedback_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE action_items
  ADD CONSTRAINT action_items_submission_canonical_fk
  FOREIGN KEY (feedback_submission_id, canonical_feedback_id)
  REFERENCES feedback_submissions (id, canonical_feedback_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE duplicate_candidates
  DROP CONSTRAINT duplicate_candidates_canonical_feedback_id_candidate_feedback_id_key,
  ADD COLUMN pair_low TEXT GENERATED ALWAYS AS (LEAST(canonical_feedback_id, candidate_feedback_id)) STORED,
  ADD COLUMN pair_high TEXT GENERATED ALWAYS AS (GREATEST(canonical_feedback_id, candidate_feedback_id)) STORED,
  ADD COLUMN decided_at TIMESTAMPTZ,
  ADD COLUMN decided_by TEXT,
  ADD COLUMN decision_reason TEXT,
  ADD COLUMN merge_operation_id TEXT,
  ADD CONSTRAINT duplicate_candidates_pair_unique UNIQUE (pair_low, pair_high),
  ADD CONSTRAINT duplicate_candidates_status_check
    CHECK (status IN ('pending', 'rejected', 'confirmed', 'superseded'));

ALTER TABLE duplicate_candidates ALTER COLUMN score SET NOT NULL;

ALTER TABLE feedback_submissions ADD COLUMN original_text TEXT;

UPDATE feedback_submissions fs
SET original_text = cf.canonical_text
FROM canonical_feedback cf
WHERE fs.canonical_feedback_id = cf.id
  AND fs.original_text IS NULL
  AND fs.legacy_feedback_id IS NOT NULL
  AND 1 = (
    SELECT COUNT(*) FROM feedback_submissions sibling
    WHERE sibling.canonical_feedback_id = fs.canonical_feedback_id
  );

CREATE TABLE canonical_merge_operations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES duplicate_candidates (id) ON DELETE RESTRICT,
  winner_id TEXT NOT NULL REFERENCES canonical_feedback (id) ON DELETE RESTRICT,
  loser_id TEXT NOT NULL REFERENCES canonical_feedback (id) ON DELETE RESTRICT,
  moved_submission_count INTEGER NOT NULL CHECK (moved_submission_count >= 0),
  moved_action_item_count INTEGER NOT NULL CHECK (moved_action_item_count >= 0),
  moved_closed_loop_count INTEGER NOT NULL CHECK (moved_closed_loop_count >= 0),
  evidence_snapshot JSONB NOT NULL,
  reason TEXT NOT NULL,
  actor_label TEXT,
  request_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (winner_id <> loser_id)
);

ALTER TABLE duplicate_candidates
  ADD CONSTRAINT duplicate_candidates_merge_operation_fk
  FOREIGN KEY (merge_operation_id) REFERENCES canonical_merge_operations (id) ON DELETE RESTRICT;

CREATE TABLE canonical_feedback_aliases (
  alias_id TEXT PRIMARY KEY REFERENCES canonical_feedback (id) ON DELETE RESTRICT,
  canonical_feedback_id TEXT NOT NULL REFERENCES canonical_feedback (id) ON DELETE RESTRICT,
  merge_operation_id TEXT NOT NULL REFERENCES canonical_merge_operations (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (alias_id <> canonical_feedback_id)
);

CREATE FUNCTION reject_merge_audit_changes() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'canonical merge audit records are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER canonical_merge_operations_immutable
BEFORE UPDATE OR DELETE ON canonical_merge_operations
FOR EACH ROW EXECUTE FUNCTION reject_merge_audit_changes();

CREATE TRIGGER canonical_feedback_aliases_immutable
BEFORE UPDATE OR DELETE ON canonical_feedback_aliases
FOR EACH ROW EXECUTE FUNCTION reject_merge_audit_changes();

CREATE FUNCTION require_active_canonical_alias_target() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM canonical_feedback
    WHERE id = NEW.canonical_feedback_id AND merged_into_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'canonical alias target must be active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER canonical_feedback_alias_target_active
AFTER INSERT ON canonical_feedback_aliases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_active_canonical_alias_target();

ALTER TABLE canonical_summaries
  ADD COLUMN stale BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN stale_at TIMESTAMPTZ;
