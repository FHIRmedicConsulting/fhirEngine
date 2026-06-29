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

1. **Current-version materialization — the #1 lever.** The window-function-over-all-versions
   dominates cost as version count grows. Fixes:
   - **Medallion: Gold = the current-version table** (one row per id, no history). Reads/
     searches hit Gold → no window function, no historical rows scanned. *This is exactly
     why Gold is the operational store* (see `deployment-topology.md`).
   - **Single store:** add an `is_current` boolean maintained on write (MERGE flips the prior
     version), so search filters `WHERE is_current AND NOT deleted`. Cost: a MERGE per write
     (single-writer). Or keep a separate current-version projection. Trade-off to decide with
     the storage-topology ADR.

2. **Compaction / OPTIMIZE — high value, low effort, do soon.** Append-per-write creates one
   small file per create/update → file count explodes → scans get slow. delta-rs supports
   `optimize.compact()` (bin-packing) and `vacuum` (drop tombstoned files past retention).
   Expose both via the sidecar and run periodically (or after N writes). This is the single
   cheapest production win and is independent of topology.

3. **File-skipping via column statistics — already on; keep the layout favorable.** Delta
   keeps per-file min/max stats for leading scalar columns. Predicates on `id` and
   `last_updated` (point reads, `_lastUpdated`, `_id`) can skip files. Keep `id`/`version_id`/
   `last_updated` as leading columns (they are) and avoid wasting stats on the big `body_json`
   string. If delta-rs Z-order/clustering is available, clustering by `id` tightens
   point-read skipping.

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
