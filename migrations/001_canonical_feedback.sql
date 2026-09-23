CREATE TABLE IF NOT EXISTS app_data (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO app_data (id, payload) VALUES ('main', '{}')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS dedup_cache (
  initiative_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE legacy_import_snapshots (
  id TEXT PRIMARY KEY,
  raw_legacy JSONB NOT NULL,
  source_updated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION reject_legacy_snapshot_changes() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'legacy import snapshots are immutable';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER legacy_import_snapshots_immutable
BEFORE UPDATE OR DELETE ON legacy_import_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_legacy_snapshot_changes();

CREATE TABLE initiatives (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rollout_date DATE,
  color TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE initiative_enablement (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  ou_key TEXT NOT NULL,
  original_ordinal INTEGER NOT NULL CHECK (original_ordinal >= 0),
  format TEXT NOT NULL,
  enabled_on DATE,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (initiative_id, ou_key)
);

CREATE TABLE canonical_feedback (
  id TEXT PRIMARY KEY,
  initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  title TEXT,
  canonical_text TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE feedback_submissions (
  id TEXT PRIMARY KEY,
  canonical_feedback_id TEXT NOT NULL REFERENCES canonical_feedback(id) ON DELETE CASCADE,
  initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL,
  legacy_snapshot_id TEXT NOT NULL REFERENCES legacy_import_snapshots(id) ON DELETE RESTRICT,
  legacy_feedback_id TEXT NOT NULL UNIQUE,
  original_ordinal INTEGER NOT NULL CHECK (original_ordinal >= 0),
  provider_snapshot JSONB NOT NULL,
  source_data JSONB NOT NULL,
  raw_legacy JSONB NOT NULL,
  submitted_on DATE,
  source_created_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION preserve_feedback_submission_legacy_data() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.raw_legacy IS DISTINCT FROM NEW.raw_legacy
    OR OLD.legacy_feedback_id IS DISTINCT FROM NEW.legacy_feedback_id
    OR OLD.original_ordinal IS DISTINCT FROM NEW.original_ordinal THEN
    RAISE EXCEPTION 'feedback submission legacy data is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feedback_submissions_legacy_data_immutable
BEFORE UPDATE ON feedback_submissions
FOR EACH ROW EXECUTE FUNCTION preserve_feedback_submission_legacy_data();

CREATE TABLE action_items (
  id TEXT PRIMARY KEY,
  canonical_feedback_id TEXT NOT NULL REFERENCES canonical_feedback(id) ON DELETE CASCADE,
  feedback_submission_id TEXT NOT NULL REFERENCES feedback_submissions(id) ON DELETE CASCADE,
  legacy_snapshot_id TEXT NOT NULL REFERENCES legacy_import_snapshots(id) ON DELETE RESTRICT,
  original_ordinal INTEGER NOT NULL CHECK (original_ordinal >= 0),
  raw_legacy JSONB NOT NULL,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE closed_loops (
  id TEXT PRIMARY KEY,
  canonical_feedback_id TEXT NOT NULL REFERENCES canonical_feedback(id) ON DELETE CASCADE,
  feedback_submission_id TEXT NOT NULL UNIQUE REFERENCES feedback_submissions(id) ON DELETE CASCADE,
  legacy_snapshot_id TEXT NOT NULL REFERENCES legacy_import_snapshots(id) ON DELETE RESTRICT,
  raw_legacy JSONB NOT NULL,
  how_incorporated TEXT NOT NULL DEFAULT '',
  communicated_back TEXT NOT NULL DEFAULT 'Pending',
  communication_method TEXT NOT NULL DEFAULT '',
  closed_date DATE,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE VIEW canonical_feedback_status AS
SELECT
  cf.id AS canonical_feedback_id,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM feedback_submissions fs
      WHERE fs.canonical_feedback_id = cf.id
    ) AND NOT EXISTS (
      SELECT 1
      FROM feedback_submissions fs
      LEFT JOIN closed_loops cl ON cl.feedback_submission_id = fs.id
      WHERE fs.canonical_feedback_id = cf.id
        AND COALESCE(cl.closed, FALSE) = FALSE
    ) THEN TRUE
    ELSE FALSE
  END AS closed
FROM canonical_feedback cf;

CREATE TABLE duplicate_candidates (
  id TEXT PRIMARY KEY,
  canonical_feedback_id TEXT NOT NULL REFERENCES canonical_feedback(id) ON DELETE CASCADE,
  candidate_feedback_id TEXT NOT NULL REFERENCES canonical_feedback(id) ON DELETE CASCADE,
  score NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending',
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (canonical_feedback_id, candidate_feedback_id),
  CHECK (candidate_feedback_id <> canonical_feedback_id)
);

CREATE TABLE canonical_summaries (
  id TEXT PRIMARY KEY,
  canonical_feedback_id TEXT NOT NULL UNIQUE REFERENCES canonical_feedback(id) ON DELETE CASCADE,
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE canonical_summary_revisions (
  id TEXT PRIMARY KEY,
  canonical_summary_id TEXT NOT NULL REFERENCES canonical_summaries(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  summary_text TEXT NOT NULL,
  model_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (canonical_summary_id, revision)
);

CREATE TABLE canonical_summary_evidence (
  id TEXT PRIMARY KEY,
  canonical_summary_revision_id TEXT NOT NULL REFERENCES canonical_summary_revisions(id) ON DELETE CASCADE,
  feedback_submission_id TEXT REFERENCES feedback_submissions(id) ON DELETE SET NULL,
  evidence_text TEXT NOT NULL,
  source_data JSONB NOT NULL DEFAULT '{}'::JSONB,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX canonical_feedback_initiative_idx ON canonical_feedback(initiative_id);
CREATE INDEX initiative_enablement_initiative_idx ON initiative_enablement(initiative_id);
CREATE INDEX feedback_submissions_canonical_idx ON feedback_submissions(canonical_feedback_id);
CREATE INDEX feedback_submissions_initiative_idx ON feedback_submissions(initiative_id);
CREATE INDEX action_items_canonical_idx ON action_items(canonical_feedback_id);
CREATE INDEX action_items_submission_idx ON action_items(feedback_submission_id);
CREATE INDEX closed_loops_canonical_idx ON closed_loops(canonical_feedback_id);
CREATE INDEX duplicate_candidates_candidate_idx ON duplicate_candidates(candidate_feedback_id);
CREATE INDEX canonical_summary_revisions_summary_idx ON canonical_summary_revisions(canonical_summary_id);
CREATE INDEX canonical_summary_evidence_revision_idx ON canonical_summary_evidence(canonical_summary_revision_id);
CREATE INDEX canonical_summary_evidence_submission_idx ON canonical_summary_evidence(feedback_submission_id);
