# Canonical Field Inputs cutover runbook

## Stage 1 — barrier release

Deploy the release whose Procfile runs:

```sh
npm run cutover:prepare
```

This applies migrations and UPSERTs `canonical_cutover_state.stage = legacy_read_only` while preserving `initial_cutover_completed_at`, `baseline_source_payload_hash`, and the last active source marker. It must not auto-activate. This intentional safe protocol runs on **every deploy**, including deployments after the first cutover. Confirm all new web dynos serve `/api/canonical/cutover-state` as `legacy_read_only`; Field Input and initiative controls must show canonical cutover maintenance and remain read-only. Jira, Timeline, and Slack sidecars may continue saving.

## Stage 2 — manual activation

After every deploy's barrier web dynos are live, run (safe to retry):

```sh
npm run cutover:activate
```

The command takes the same advisory transaction lock used by API mutations and locks `app_data.main`. On the **initial activation only**, it treats the legacy source as authoritative for imported provenance: imports missing rows, refreshes/restores source-present imported rows, soft-deletes imported rows absent from source, retires parents left empty, and checks active-only semantic parity. Native canonical rows and initiatives are not legacy-owned and are preserved.

After initial cutover, repeat activation is **integrity-only**: it checks canonical relationship invariants and returns the barrier to `canonical_active` without reconciliation or legacy parity. This preserves canonical edits, soft deletes, action/loop changes, initiative/OU changes, merges, and native initiatives. If the current legacy source hash differs from the durable baseline, activation fails closed with a source drift error; do not overwrite canonical data. An explicit, reviewed operator migration is required to adopt changed legacy source.

Any error rolls back all work. Successful JSON includes `activationMode`, `baselineSourcePayloadHash`, `currentSourcePayloadHash`, and `sourcePayloadHash`; retain it as release evidence. Activation is required after every deploy. The browser reads runtime state on its next load; no second code release is needed.

## Emergency read-only

Set `REACT_APP_CANONICAL_FIELD_INPUTS=false` only as a client emergency read-only build override. Server state remains authoritative. To stop writes immediately, set `CANONICAL_FIELD_INPUTS_STAGE=barrier` and restart web dynos.

Emergency recovery procedure: keep `CANONICAL_FIELD_INPUTS_STAGE=barrier`, inspect the integrity/source-drift error, snapshot both `canonical_cutover_state` and `app_data.main`, and repair through an explicit reviewed migration. Never clear the durable completion marker or baseline hash and never rerun initial reconciliation to recover a post-cutover deployment.

### Pre-006 active-state recovery

If prepare reports a missing or mismatched pre-006 marker, its transaction rolls back, so the database remains `canonical_active`; set the emergency barrier before investigating. Read the recorded provenance exactly:

```sql
SELECT stage, source_payload_hash, baseline_source_payload_hash, initial_cutover_completed_at
FROM canonical_cutover_state WHERE name = 'field-inputs';
```

Compare `source_payload_hash` with an independently computed hash of only `app_data.main.payload` keys `initiatives`, `feedback`, and `closedLoop`, and retain both snapshots. Never use the current app_data hash as the baseline merely because it is current. The operator decision must establish whether the recorded active marker is trustworthy or whether a reviewed data migration is required.

Only when the operator has verified that the recorded active `source_payload_hash` is the true cutover source may the durable fields be repaired explicitly:

```sql
BEGIN;
SELECT * FROM canonical_cutover_state WHERE name = 'field-inputs' FOR UPDATE;
UPDATE canonical_cutover_state
SET initial_cutover_completed_at = stage_changed_at,
    baseline_source_payload_hash = source_payload_hash
WHERE name = 'field-inputs'
  AND stage = 'canonical_active'
  AND initial_cutover_completed_at IS NULL
  AND source_payload_hash = '<operator-verified-recorded-hash>';
COMMIT;
```

If the marker is missing or the source has drifted, do not invent or silently bless a hash with SQL: keep the barrier and ship a reviewed operator migration that documents the selected source and canonical-data reconciliation.
