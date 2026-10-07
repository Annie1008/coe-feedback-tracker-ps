-- Feedback Issue: the permanent record of a real business problem being tracked.
-- initiatives.id/canonical_feedback.id are TEXT columns holding app-generated UUID strings
-- (see server/canonicalApi.js's uuid()/crypto.randomUUID() helper) rather than the native
-- Postgres UUID type, so feedback_issues.id follows the same convention to stay FK-compatible.
CREATE TABLE feedback_issues (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives (id) ON DELETE RESTRICT,

  title TEXT NOT NULL,
  canonical_text TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'untriaged'
    CHECK (status IN (
      'untriaged', 'triaged', 'in_review', 'planned', 'in_progress',
      'addressed', 'closed', 'not_actionable', 'duplicate'
    )),

  -- Enum not specified by the original request; using the same low/medium/high/critical
  -- scale Step 6 (impact/priority scoring) is expected to formalize later.
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),

  -- No users table exists yet (RBAC/SSO is Step 8), so this is left as a plain, unconstrained
  -- identifier for now rather than a dangling FK to a table that doesn't exist.
  owner_user_id TEXT,

  first_reported_at TIMESTAMPTZ,
  last_reported_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- DEFAULT 1 / CHECK (version > 0), not DEFAULT 0, to match the optimistic-concurrency
  -- convention every other table in this schema uses (canonical_feedback, feedback_submissions,
  -- action_items, closed_loops, duplicate_candidates, canonical_summaries all start at 1).
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),

  retired_at TIMESTAMPTZ
);

CREATE INDEX feedback_issues_initiative_idx ON feedback_issues (initiative_id);
CREATE INDEX feedback_issues_status_idx ON feedback_issues (status);
