-- Append-only audit trail of feedback_issues.status transitions, so "what happened to
-- this feedback and when" can be answered without inferring it from updated_at alone.
CREATE TABLE feedback_issue_status_history (
  id TEXT PRIMARY KEY,

  feedback_issue_id TEXT NOT NULL
    REFERENCES feedback_issues (id) ON DELETE CASCADE,

  from_status TEXT
    CHECK (from_status IS NULL OR from_status IN (
      'untriaged', 'triaged', 'in_review', 'planned', 'in_progress',
      'addressed', 'closed', 'not_actionable', 'duplicate'
    )),
  to_status TEXT NOT NULL
    CHECK (to_status IN (
      'untriaged', 'triaged', 'in_review', 'planned', 'in_progress',
      'addressed', 'closed', 'not_actionable', 'duplicate'
    )),

  -- Open string (not enumerated in the request): who/what triggered the transition,
  -- e.g. 'human', 'jira_sync'. Left unconstrained like feedback_issue_delivery_links.provider.
  source TEXT NOT NULL,

  reason TEXT,

  -- No users table yet (RBAC/SSO is a later step) — plain unconstrained identifier for now.
  changed_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX feedback_issue_status_history_issue_idx
  ON feedback_issue_status_history (feedback_issue_id, created_at, id);
