-- Links a feedback_issue to one or more external delivery tickets (Jira today; "provider"
-- stays an open string rather than an enum since other providers may show up later and
-- there's no fixed, closed set of them the way there is for relationship/verification state).
CREATE TABLE feedback_issue_delivery_links (
  id TEXT PRIMARY KEY,

  feedback_issue_id TEXT NOT NULL
    REFERENCES feedback_issues (id) ON DELETE CASCADE,

  provider TEXT NOT NULL,
  external_key TEXT NOT NULL,

  relationship_type TEXT NOT NULL
    CHECK (relationship_type IN (
      'addresses', 'partially_addresses', 'blocked_by',
      'duplicate_of', 'related_to', 'supersedes'
    )),

  match_source TEXT NOT NULL
    CHECK (match_source IN ('ai', 'human')),

  confidence NUMERIC(5,4),

  verification_status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (verification_status IN ('suggested', 'confirmed', 'rejected')),

  -- No users table yet (RBAC/SSO is a later step) — plain unconstrained identifier for now.
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (feedback_issue_id, provider, external_key)
);

-- Reverse lookup: "is this Jira ticket already linked to a feedback issue, and which one"
-- — the UNIQUE index above only covers lookups starting from feedback_issue_id.
CREATE INDEX feedback_issue_delivery_links_external_idx
  ON feedback_issue_delivery_links (provider, external_key);
