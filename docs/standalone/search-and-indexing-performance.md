# Search & indexing performance (Delta)

Design note (session 032). Answers: "do we need additional indexing on the Delta tables
to speed search/performance?" Short answer: **Delta has no secondary (B-tree) indexes like
an OLTP DB — "indexing" here means file-skipping (column stats), clustering, and
compaction. We don't need traditional indexes; we need three things, in priority order.**

## How search runs today

Per resource type: one Delta table with `id, version_id, last_updated, body_json,
identifier_index (array<struct>), search_param_index (array<struct>), deleted, …`.
Every search/read:

1. computes current versions with `row_number() OVER (PARTITION BY id ORDER BY version_id
   DESC)` and filters `rn=1 AND NOT deleted` — **scans all historical versions every time**,
2. unnests `search_param_index` and matches conditions (token/string/date/number/ref).

Correct and fine for dev/synthetic volumes. The scaling costs are predictable.

## What actually helps (priority order)

1. **Current-version materialization — the #1 lever. ✅ DONE (single store).** The
   window-function-over-all-versions dominated cost as version count grows. Implemented:
   - **Single store: an `is_current` boolean maintained on write.** Search now filters
     `WHERE is_current AND NOT deleted` — no `row_number() OVER (PARTITION BY id …)` scan over
     history. Applied to all three hot paths (`searchByParams` `cur` CTE, `findReferencing`,
     `searchByIdentifier`).
   - **Atomic, no read window.** Each write is ONE Delta MERGE (`/write-version`) that inserts
     the new version (`is_current=true`) and demotes the prior (`is_current=false`) in a single
     commit — snapshot-isolated readers never see two-current or zero-current for an id. (A
     plain append-then-flip would expose a transient double-current under the threaded sidecar.)
     Cost: one MERGE per write (single-writer; pairs with the Z-order-by-id clustering in #2a so
     the demote's id-point-update skips files). Point reads/`currentRow` stay `ORDER BY
     version_id DESC LIMIT 1` (already cheap). History/vread/`_history` read all versions, unchanged.
   - Verified: `delta-current-version` (one current row per id, no search duplicates, history
     retained, tombstone excluded) + full suite green.
   - **Medallion: Gold = the current-version table** (one row per id, no history) remains the
     medallion answer (see `deployment-topology.md`); the `is_current` flag is the single-store
     equivalent. Schema-evolution note: existing pre-`is_current` Bronze tables need a backfill
     migration (out of scope here; fresh stores get the column from the fixed BRONZE_SCHEMA).

2. **Compaction / OPTIMIZE + VACUUM — ✅ DONE (Priority #1).** Append-per-write creates one
   small file per create/update/audit/terminology-batch → file count explodes → scans slow.
   Store-wide maintenance shipped:
   - Sidecar `/optimize` (one table) + `/optimize-all` (walks the base, compacts **every**
     Delta table — Bronze per type, audit, terminology, conformance, dead-letter, pending),
     each with optional `vacuum` (safe **168h enforced** retention by default; `force` for dev).
   - `DeltaWarehouse.optimizeAll/optimize/optimizeTerminology` (`OptimizeOpts`).
   - `lib/maintenance.ts` — `runMaintenance` + opt-in single-flight `startMaintenanceScheduler`
     (`RONIN_MAINTENANCE_INTERVAL_MIN`, `RONIN_VACUUM_ENABLED`, `RONIN_VACUUM_RETENTION_HOURS`),
     wired into the server entry.
   - CLI `optimize [--vacuum] [--retention-hours N] [--force] [--no-zorder] [tables…]`. Tested.
   - Follow-up: object-store base enumeration (currently local-FS walk).

2a. **Z-order / clustering by `id` — ✅ DONE.** delta-rs (`deltalake` 1.6.1) exposes
   `optimize.z_order(columns)`. `optimize-all` auto-clusters by `id` on every table that has an
   `id` column (Bronze resource tables + audit) and falls back to plain `compact()` for tables
   without one (terminology). Clustering co-locates a resource's rows so id-keyed access — point
   reads, `_id`, and the current-version window (`PARTITION BY id`) — skips files via min/max
   stats. Override: `OptimizeOpts.zorder` (explicit columns or `false`); CLI `--no-zorder`.
   Runs as part of OPTIMIZE — no extra pass over #2.

3. **File-skipping via column statistics — already on; keep the layout favorable.** Delta
   keeps per-file min/max stats for leading scalar columns. Predicates on `id` and
   `last_updated` (point reads, `_lastUpdated`, `_id`) can skip files — and Z-order by `id`
   (#2a) tightens that skipping. Keep `id`/`version_id`/`last_updated` as leading columns
   (they are) and avoid wasting stats on the big `body_json` string.

## What does NOT help (don't add)

- **Traditional secondary indexes** — Delta has none; don't design for them.
- **Partitioning** — FHIR has no natural low-cardinality partition key; partitioning risks
  many small files. Skip unless a concrete key emerges (e.g. month-of-`last_updated` for
  history-heavy workloads).
- The **`search_param_index` array column is not file-skippable** (predicates run post-unnest),
  so stats can't prune for param search. The scalable answer for param-search pushdown is
  **flattened scalar columns** (the clean-room flattener's Silver output) + clustering — the
  deferred Silver work, not an "index."

## Recommendation

Nothing is *required* for current dev/conformance work. Before real scale: (2) compaction/
vacuum now (cheap, topology-independent), then (1) current-version materialization as part of
the storage-topology/medallion ADR, then (eventually) (flattened columns) if param-search
pushdown is needed. Ratify alongside the storage-topology ADR.
