SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE canonical_cutover_state
  ADD COLUMN initial_cutover_completed_at TIMESTAMPTZ,
  ADD COLUMN baseline_source_payload_hash TEXT;

ALTER TABLE initiatives
  ADD COLUMN legacy_imported BOOLEAN NOT NULL DEFAULT FALSE;

-- Migration/import snapshots are immutable provenance. Mark only initiative IDs actually
-- present in one of those snapshots; all other existing rows remain native-owned.
UPDATE initiatives initiative
SET legacy_imported = TRUE
WHERE EXISTS (
  SELECT 1
  FROM legacy_import_snapshots snapshot
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(snapshot.raw_legacy->'initiatives') = 'array'
      THEN snapshot.raw_legacy->'initiatives' ELSE '[]'::JSONB END
  ) source_initiative
  WHERE source_initiative->>'id' = initiative.id
)
OR EXISTS (
  SELECT 1 FROM feedback_submissions submission
  WHERE submission.initiative_id = initiative.id
    AND submission.legacy_snapshot_id IS NOT NULL
);
