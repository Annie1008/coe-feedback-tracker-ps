SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

-- Links each canonical_feedback row to the permanent feedback_issue that owns it.
-- Nullable and unbacked by a DEFAULT: existing rows have no feedback_issue yet (that
-- backfill is a separate, deliberate step, not this migration) and this stays an
-- incremental extension of the current feedback_submissions -> canonical_feedback
-- projection rather than a rewrite of it.
-- feedback_issues.id is TEXT (see migrations/007_feedback_issues.sql for why), so this
-- column matches that type rather than the native UUID type to stay FK-compatible.
ALTER TABLE canonical_feedback
  ADD COLUMN feedback_issue_id TEXT REFERENCES feedback_issues (id) ON DELETE SET NULL;

CREATE INDEX canonical_feedback_feedback_issue_idx ON canonical_feedback (feedback_issue_id);
