# ADR-0026: Medallion Promotion Orchestration — Delta CDF, No DLT

- Status: **Proposed** (design research-validated; ratify on implementation with `DeltaWarehouse`). RoninStandAlone-specific.
- Date: 2026-06-27
- Decider(s): Chad
- Session: 032 (standalone fork)
- Supersedes (for RoninStandAlone): the **three-DLT-pipeline** promotion architecture of [ADR-0019 §7](0019-storage-and-pipeline-operations.md) (Databricks DLT). ADR-0019 stays in force for Ronin.
- Related: [ADR-0022](0022-standalone-storage-flattening-and-catalog-seam.md), [ADR-0024](0024-clean-room-r4-columnar-schema-generator.md), [ADR-0010 A3/A4](0010-storage-shape.md), [feasibility review](../research/2026-06-27-standalone-engine-feasibility.md)

## Context

ADR-0010/0019 (heritage) drive Bronze→Silver→Gold promotion with **Databricks DLT
pipelines** on Spark + Delta CDF. RoninStandAlone has no Databricks, no Spark, no
DLT. This ADR defines how the same medallion promotion runs over **OSS Delta with
the single delta-rs / DataFusion engine** (per ADR-0022 Amendment 1; Layering B:
Bronze raw → Silver flattened/governed → Gold transactional). Research-verified June
2026 (`deltalake` 1.6.1).

Key engine fact (verified):
- **delta-rs supports Change Data Feed reads** — `DeltaTable.load_cdf(starting_version, ending_version, …)` returns an Arrow `RecordBatchReader` with `_change_type`/`_commit_version`. Requires `delta.enableChangeDataFeed=true` **set at table creation**. Historically materialized the change window in memory ([#3388](https://github.com/delta-io/delta-rs/issues/3388)) → use **bounded version windows**. Timestamp-range CDF has had bugs ([#3023](https://github.com/delta-io/delta-rs/issues/3023)) → **use version-based windows, not timestamps**.

## Decision

### 1. One engine
The **delta-rs / DataFusion engine** (Python sidecar, already the single-writer per
ADR-0022) does all writes, **all promotion**, and serves reads. No Spark, no DLT,
no second query engine.

### 2. Incremental promotion via CDF, version-windowed
Per layer transition (Bronze→Silver, Silver→Gold), a worker loop:
1. Read watermark `N` (last fully-processed source version) for table T.
2. `M = DeltaTable(source/T).version()`; if `M == N`, sleep.
3. `load_cdf(starting_version=N+1, ending_version=min(N+K, M))` — **bounded window
   of ≤K versions** (caps the in-memory materialization).
4. Apply the transform: Bronze→Silver = clean-room flatten (ADR-0024) + governance;
   Silver→Gold = denorm/projection. Collapse CDF `update_preimage`/`postimage` to
   the postimage keyed by FHIR logical id; map `delete` to the soft-delete tombstone.
5. **MERGE into the target** keyed on FHIR id (`when_matched_update_all` /
   `when_not_matched_insert_all` / delete branch).
6. **Only after the target MERGE commits**, advance the watermark to the processed
   version (commit-data-then-advance ordering — §5).

`delta.enableChangeDataFeed=true` is set on every Bronze and Silver table **at
creation** (bootstrap/DDL invariant). Tables without it can only be full-rebuilt.

### 3. Watermark store
Watermarks live in a dedicated **Delta meta-table** (`_meta.promotion_watermarks`:
`layer, table, last_version, updated_at`), updated by MERGE — one storage substrate,
atomic, replayable, no extra database. (A per-table JSON file is an acceptable
single-node fallback; the Delta meta-table is preferred for atomicity.)

### 4. Full-rebuild backstop (authoritative)
Because Bronze retains `body_json` as source-of-truth (ADR-0024 §1), a **full
snapshot rebuild of Silver/Gold from Bronze** is the canonical "reprocess on rule
change / CDF gap" path. CDF is the fast incremental path; full-rebuild is the truth
path and sidesteps CDF's "only-after-enable" limitation. Both are first-class
operator commands; both are idempotent (MERGE on stable key).

### 5. Concurrency & correctness
- **One writer per Delta table** is the core invariant (the sidecar per table) —
  it sidesteps delta-rs optimistic-concurrency/multi-writer hazards entirely. Delta
  commit atomicity comes from the storage layer; no external commit-coordination
  service is in scope (concurrent multi-writer is not a supported requirement).
- **MERGE keyed on FHIR id is idempotent** → reprocessing a window converges.
- **Commit data first, advance watermark second** → a crash between them re-MERGEs
  the same window harmlessly. Never advance the watermark before the data commit.

### 6. Orchestration shape
A **long-lived Python worker with an internal poll loop** (micro-batch every ~2–10s),
supervised by **systemd / container restart policy / supervisord**. The TS server
never orchestrates promotion — it writes Bronze and reads Gold. **No Airflow/Dagster/
Prefect, no DLT** for v1: a poll loop + Delta watermark table *is* the orchestrator.
Scale path: one worker → table-sharded workers (one writer per table preserved) →
optional Bronze-commit signal to go event-driven (still no Spark). Micro-batch
polling is sufficient because Bronze→Silver→Gold is already eventually-consistent
(ADR-0010); interactive reads hit Gold snapshots and are unaffected by promotion lag.

## Consequences

- Promotion is plain orchestrated code in the existing sidecar — no new heavy
  infrastructure; runs identically on a laptop and on a server (local-first goal).
- `enableChangeDataFeed=true` becomes a mandatory table property in the standalone
  DDL/bootstrap; enforce it or the table is incremental-promotion-ineligible.
- The full-rebuild path makes rule changes / validation-version bumps safe and is
  the correctness anchor (matches ADR-0010 A3 reprocessing semantics).
- Eventual consistency Bronze→Silver→Gold is retained from the heritage design;
  read-your-writes for the FHIR API is handled at the Gold/serving layer, not here.

## Alternatives considered

- **DLT / Spark Structured Streaming** — rejected (Databricks/Spark; the thing we shed).
- **Version-diff snapshot comparison instead of CDF** — viable fallback where CDF
  wasn't enabled, but CDF gives exact changed rows + change types and removes diff
  logic; kept only as the not-enabled fallback.
- **Timestamp-based watermarks** — rejected (delta-rs timestamp-range CDF bugs;
  versions are exact + monotonic).
- **Airflow/Dagster** — rejected for v1 (overkill; poll loop + watermark table suffices).

## Top risks

1. **CDF in-memory materialization** (#3388) — bound the per-tick version window.
2. **CDF-not-enabled trap** — enforce `enableChangeDataFeed=true` in DDL; otherwise full-rebuild-only.
3. **Multi-writer corruption** — enforce one-writer-per-table as a hard invariant (the design already is).
4. **CDF API maturity** — pin the `deltalake` version; cover with the full-rebuild backstop if `load_cdf` behavior shifts across releases.

## Open questions

- Window size K and poll interval defaults (tune against Bronze ingest rate).
- Where `_meta.promotion_watermarks` lives relative to the data catalog (ADR-0025).
- Whether Silver governance (validation/MPI/DQ) runs inline in this loop or as a
  distinct stage — ties to ADR-0015 (validation) port for standalone.
