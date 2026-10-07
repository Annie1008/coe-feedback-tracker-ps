-- Many-to-many membership between a feedback_issue and the canonical_feedback rows
-- that make it up, with provenance (AI vs. human) and a verification state per
-- membership. This is the real source of truth for "what belongs to this issue";
-- canonical_feedback.feedback_issue_id (migration 008) is a denormalized shortcut
-- for the common single-owner case and isn't replaced by this table yet.
CREATE TABLE feedback_issue_members (
  feedback_issue_id TEXT NOT NULL
    REFERENCES feedback_issues (id) ON DELETE CASCADE,

  canonical_feedback_id TEXT NOT NULL
    REFERENCES canonical_feedback (id) ON DELETE CASCADE,

  membership_type TEXT NOT NULL DEFAULT 'ai'
    CHECK (membership_type IN ('ai', 'human')),

  confidence NUMERIC(5,4),

  verified BOOLEAN NOT NULL DEFAULT FALSE,

  -- No users table yet (RBAC/SSO is a later step) — plain unconstrained identifier for now.
  verified_by TEXT,

  verified_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (feedback_issue_id, canonical_feedback_id)
);

-- The primary key already indexes (feedback_issue_id, ...) for the "members of this
-- issue" direction; this covers the reverse "which issue(s) is this feedback part of" lookup.
CREATE INDEX feedback_issue_members_canonical_idx ON feedback_issue_members (canonical_feedback_id);
