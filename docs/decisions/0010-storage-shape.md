# ADR-0010: Storage Shape — Layered Append-Only Design with Materialized Patient Compartment

- Status: **Accepted** · Amended 2026-06-19 (A1: Bronze tier; A2: Silver→Gold collapse; A3: Silver reinstated as substantive tier) · 2026-06-27 (A4: dbignite flattened tables + soft-delete + Silver build)
- Date: 2026-06-19
- Decider(s): Chad
- Session: 011 (original), 014 (Amendments 1+2), 018 (Amendment 3)
- Related: [ADR-0008](0008-updated-vision-and-scope.md), [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md), [ADR-0011](0011-write-contract.md), [ADR-0012](0012-master-patient-index.md), [ADR-0013](0013-deployment-posture.md), [docs/research/2026-06-17-lakehouse-storage-and-crud.md](../research/2026-06-17-lakehouse-storage-and-crud.md), [docs/research/2026-06-19-patient-compartment-options.md](../research/2026-06-19-patient-compartment-options.md), [docs/research/2026-06-18-payer-volume-sizing.md](../research/2026-06-18-payer-volume-sizing.md), [docs/research/2026-06-18-microbatch-write-path.md](../research/2026-06-18-microbatch-write-path.md), [docs/research/2026-06-19-bronze-to-silver-governance.md](../research/2026-06-19-bronze-to-silver-governance.md), [docs/research/2026-06-19-ronin-mpi-design.md](../research/2026-06-19-ronin-mpi-design.md), [docs/research/2026-06-19-validation-architecture.md](../research/2026-06-19-validation-architecture.md)

## Context

The storage research note (`docs/research/2026-06-17-lakehouse-storage-and-crud.md`) evolved through sessions 003–010, gathering inputs from the dbignite deep read (session 005), the body-vs-projection split (session 005 late correction), the polyglot write contract (sessions 006–008), the session-009 POC measurements (single-row INSERT ~1.5s p50, single-table OCC ceiling ~1.3 writes/sec, resolver read ~0.8s p50), the [10M-member sizing model](../research/2026-06-18-payer-volume-sizing.md), and the [positioning review](../research/2026-06-19-positioning-review-big-and-fast.md).

This ADR ratifies the storage shape that results. It establishes the layered structure, the partition strategy, the projection-update timing, and the materialized Patient compartment design as v1 commitments. Open questions in the research note that needed Chad's input have been resolved (Option G for Patient compartment; 7-day error retention configurable per deployment; etc.).

## Decision

### 1. Body schema is vanilla dbignite

Resource bodies are stored using **dbignite's hierarchical FHIR JSON Schema → Spark StructType** representation, per FHIR version, **unmodified**. Per ADR-0008 D2 and ADR-0009 Amendment 2. References stay as raw strings; extensions stay as `array<string>`; the primitive-extension `_field` sibling pattern is preserved. All Ronin smarts live in the projection layer; the body is dbignite's responsibility.

### 2. Layered storage structure

Five layers. Layer 1 is the source of truth; everything else is a derived projection. The source-of-truth principle from ADR-0008 D2 stands.

#### Layer 1 — Resource tables (one per `(resource_type, fhir_version)`)

Append-only. One Delta table per `(resource_type, fhir_version)` combination. Naming: `ronin_<warehouse>.gold.<resource_type>_<fhir_version>` (e.g., `ronin_default.gold.patient_r4`, `patient_r5`).

Schema (operational columns at the table level alongside the dbignite body STRUCT):

```
fhir_id              STRING        -- server-assigned UUID v7 (see §3.5)
version_id           BIGINT        -- monotonic per (resource_type, fhir_id); becomes meta.versionId
last_updated         TIMESTAMP     -- becomes meta.lastUpdated; UTC, microsecond precision
fhir_version         STRING        -- "4.0.1", "4.3.0", "5.0.0"
source               STRING        -- becomes meta.source URI
profile              ARRAY<STRING> -- becomes meta.profile[]
security             ARRAY<STRUCT<system, code, display>>
tag                  ARRAY<STRUCT<system, code, display>>
deleted              BOOLEAN       -- true = delete tombstone; latest-version filter respects this
member_id            STRING        -- denormalized for Patient compartment queries (see §2.5)
body                 STRUCT<...>   -- vanilla dbignite body schema for this resource type / version
ingested_at          TIMESTAMP     -- when the row landed (distinct from last_updated; retention/observability)
ingest_request_id    STRING        -- correlation handle for the write that produced this row
```

Write pattern: **append-only**. Every Create, Update, Delete, Conditional Update, and PATCH produces a new row with an incremented `version_id`. Deletes are append rows with `deleted = true`.

#### Layer 2 — Identifier projection (`identifier_index`)

Cross-resource denormalized table. One row per `(resource_type, fhir_id, identifier_system, identifier_value, identifier_use, identifier_type, identifier_period_start, identifier_period_end, assigner_fhir_id, last_updated, deleted, ingested_at)`. Schema as proposed in the storage research note Layer 2.

Drives Conditional Update resolution (the read-then-write hot path), cross-resource entity lookup, external-system reverse lookup, and the MDM substrate.

#### Layer 2b — References projection (`references_index`)

Cross-resource denormalized table for references. One row per `(source_resource_type, source_fhir_id, source_fhir_version, source_version_id, ref_path, target_resource_type, target_fhir_id, target_external_url, target_display, target_identifier_system, target_identifier_value, last_updated, deleted, ingested_at)`. Schema as proposed in the storage research note Layer 2b.

Drives search-by-reference, compartment queries that need transitivity, JOIN performance, and MDM cross-resource lookups.

#### Layer 3 — Current-version projection (per `(resource_type, fhir_version)`)

For each Layer 1 resource table, an incrementally-materialized projection of `MAX(version_id) per fhir_id WHERE deleted = false`. Maintained by Delta CDF → Spark Structured Streaming pipelines (DLT pipelines on Databricks deployments).

Used for point reads (`GET /<ResourceType>/{id}`) and the resolver-read's "latest version" check in Conditional Update. Reads against the underlying append-only Layer 1 table are reserved for `_history` / vread.

#### Layer 4 — Materialized Patient compartment

Per [Option G in the Patient compartment options note](../research/2026-06-19-patient-compartment-options.md). Two sub-layers:

- **Layer 4a — Per-(member, resource_type, fhir_version) rows.** Keyed by `(member_id, resource_type, fhir_version)`. Each row carries an ARRAY of compartment-current-state resource bodies. Updated **synchronously within the same micro-batch coordinator commit** as the source Layer 1 write (per the [micro-batch sketch](../research/2026-06-18-microbatch-write-path.md), §"Projection-update timing"). Serves fresh reads: `GET /Patient/{id}/{ResourceType}`, `$everything?_since=...`, Provider Access compartment queries.
- **Layer 4b — Pre-rendered NDJSON files per `(member_id, fhir_version)`.** Stored in UC Volume at `/Volumes/<catalog>/gold/patient_compartments/{fhir_version}/{member_id}.ndjson`. Refreshed by a DLT pipeline on a 15-minute cadence for active members (any member whose Layer 4a saw a write in the last hour) and a daily cadence for cold members. Serves stale-OK reads: `GET /Patient/{id}/$everything` initial-sync calls without `_since`.

Read routing (lives in the TS server's REST handlers):

| Endpoint | Source | Staleness |
|---|---|---|
| `GET /<ResourceType>/{id}` | Layer 3 (current-version projection) | Fresh |
| `GET /Patient/{id}/{ResourceType}` | Layer 4a | Fresh |
| `GET /Patient/{id}/$everything` (no `_since`) | Layer 4b NDJSON file | ≤15 min (active) / ≤24h (cold) |
| `GET /Patient/{id}/$everything?_since=…` | Layer 4a partial scan | Fresh |
| Provider Access compartment query | Layer 4a | Fresh |
| `_history` / vread | Layer 1 directly | Fresh (point read by `(fhir_id, version_id)`) |
| Bulk Export `$export` | Layer 1 + Layer 3 streaming | Eventually consistent within ingest window |

Read-your-writes invariant: writes-then-fetch always hits Layer 4a (synchronously updated in the same commit). Layer 4b is only the stale-OK `$everything` initial-sync path.

### 2.5 `member_id` denormalization

Source resource-table rows whose resource has a Patient compartment membership carry a denormalized `member_id` column (the `fhir_id` of the referenced Patient). Populated at write time by the resolver, before the row enters the micro-batch coordinator's queue. NULL for resources outside any Patient compartment (Organization, Practitioner, etc.).

This matches Option C from the Patient compartment options note as a complement to Option G. It makes Layer 4a maintenance a trivial group-by aggregation per resource type rather than a multi-table join.

### 3. Partition strategy

High-volume tables under sustained ingest hit the Delta single-table OCC ceiling (~1.3 writes/sec measured session 009) without partitioning. Per-resource-type recommendations:

| Table | Partition keys | Bucket count default |
|---|---|---|
| `claim_r4` / `claim_r5` | `(year_month(last_updated), member_hash_bucket(fhir_id))` | 64 |
| `explanation_of_benefit_r4` / r5 | Same as Claim | 64 |
| `observation_r4` / r5 | `(year_month, member_hash_bucket)` | 64 (provider deployments: 128) |
| `coverage_r4` / r5 | `(year_month)` | n/a |
| `patient_r4` / r5 | `(member_hash_bucket(fhir_id))` | 64 |
| `encounter_r4` / r5 | `(year_month, member_hash_bucket)` | 64 |
| Other compartment resources (default) | `(year_month)` if accumulating; unpartitioned if reference data | n/a |
| `identifier_index` | `(identifier_system_hash_bucket)` | 16 |
| `references_index` | `(target_resource_type)` | natural |
| Layer 4a tables | `(member_hash_bucket, resource_type)` | 64 |

Bucket counts are exposed as per-table tuning parameters. v1 mid-size customers (1M–5M members) can start with 16 buckets; 10M-member-payer deployments default to 64; healthcare-provider IDN deployments can scale to 128 or 256 without schema change. Hash function: stable hash of the partition key value, distributing rows evenly across buckets.

### 4. OPTIMIZE / VACUUM policy

Sustained bulk ingest produces many small Delta files; without compaction, both read latency and commit cost grow. Policy:

- **Hot partitions** (current `year_month` for time-partitioned tables; recently-written hash buckets for member-hash-partitioned tables): `OPTIMIZE` every 6 hours; ZORDER on `(fhir_id, last_updated)` within partition.
- **Cold partitions**: `OPTIMIZE` nightly.
- **VACUUM**: weekly, retention 7 days (Delta default — keeps `_history` reachable for at least one week of vread queries even on accumulated tables).
- **Auto-compaction**: enabled on Delta tables that take Spark writes (Layer 1 from the bulk path); disabled on tables that take SQL Driver writes (Layer 1 from the interactive path) because auto-compaction interferes with micro-batch commit timing.

Maintenance jobs run as scheduled Databricks Jobs; failures alert via Databricks alerts → operator channel. Belongs in an ops/operability note (TBD).

### 5. ID assignment

Server-assigned **UUID v7** for `fhir_id` and `ingest_request_id`. UUID v7 is time-sortable (first 48 bits are a Unix-epoch millisecond timestamp), which gives natural locality for ZORDER and partition pruning when downstream queries filter by recent writes — better than v4 random, comparable to ULID. The remaining 74 bits are random per RFC 9562, so collisions are practically impossible.

Client-supplied IDs are **not honored at create time** for v1: every create generates a fresh UUID v7 server-side, matching the Pathling pattern. Conditional Update resolves by business identifier, not by client-supplied FHIR id; if a client wants to preserve a specific id, they use `PUT /<ResourceType>/{id}` which is treated as update-by-fhir-id.

### 6. Synchronous projection updates within the micro-batch coordinator

Per the [micro-batch sketch](../research/2026-06-18-microbatch-write-path.md) and the storage research note open question 4: identifier_index, references_index, and Layer 4a updates land **in the same batch / commit** as the source Layer 1 write, on the interactive write path. The resolver reads identifier_index, so the projection cannot be arbitrarily stale; synchronous-in-batch keeps the resolver correct at a latency cost already inside the commit floor.

On the bulk write path (Spark workers), projection updates run as **streaming projections via Delta CDF**, not synchronously. Bulk-import volume tolerates eventual consistency on projections; lag is bounded by the streaming pipeline cadence (~10–60 seconds typically). The micro-batch synchronous path only applies to interactive writes.

Layer 4b NDJSON file refresh is always asynchronous (15-minute cadence for active members; daily for cold). Endpoints served from 4b carry an `Expires` / `Last-Modified` header indicating staleness.

### 7. Append-only over MERGE

The session-009 POC measured MERGE at ~2× plain INSERT cost (~3.5s p50 vs ~1.5s p50) and scaling worse with table size. The Conditional Update flow under this design **does not use MERGE**:

1. Resolver `SELECT` against `identifier_index` decides create vs. update vs. ambiguous and obtains the target `fhir_id` (or generates one for create).
2. If updating, the resolver also reads current `MAX(version_id)` for that `fhir_id` from Layer 3.
3. The micro-batch coordinator enqueues a plain append `INSERT` of the new version row (and its projection rows).
4. No MERGE statement is issued anywhere on the operational path.

Intra-batch same-resource collisions (two ops in one batch resolve to the same `fhir_id`) are handled by serializing same-key writes across batches (Option (a) from the micro-batch sketch §"Intra-batch same-resource collisions"): if a second op in the current batch resolves to a `fhir_id` already enqueued, the second is deferred to the next batch.

### 8. Soft-delete semantics

DELETE produces an append row with `deleted = true`. The current-version projection (Layer 3) and Layer 4a filter `WHERE deleted = false`. `GET` after delete returns `410 Gone`. `_history` returns the full version chain including the delete tombstone.

Hard-delete (vacuum / purge of all versions of a resource) is not in v1 scope. Belongs in a future operational ADR if customer data-deletion requirements demand it (GDPR right-to-be-forgotten, etc.).

## Consequences

- The storage layer is committed: dbignite-canonical body schema + five layers + partitioning + synchronous projection updates in the interactive path + UUID v7 IDs + append-only-no-MERGE Conditional Update.
- Schema migration is a real concern: adding columns to Layer 1 tables means evolving Delta schemas without breaking concurrent reads/writes. Procedure belongs in an operability ADR.
- Layer 4a per-(member, resource_type) row contention is the new operational hot point. A heavy-utilizer Patient with frequent writes (vitals every minute from a connected device, for example) generates contention on the Observation row for that member. Workload monitoring and per-member rate limiting belong in the operability story.
- Layer 4b NDJSON file refresh is a continuously-running DLT pipeline; cluster sizing matters. Belongs in operability.
- The micro-batch coordinator design from the sketch becomes operationally mandatory, not optional. Confirmed by ADR-0011 (write contract).
- The Layer 3 + Layer 4a duplication on the read path (Layer 3 is per-resource-type latest version; Layer 4a is per-member per-resource-type latest versions of compartment members) is an acknowledged storage overhead. Both are materialized; Layer 4a's content is a subset of Layer 3's by resource type. Worth re-evaluating in v2 if storage cost becomes meaningful.

## Alternatives considered

- **MERGE-based Conditional Update.** Rejected — session-009 POC measured ~2× INSERT cost and worse scaling with table size. Append-only with resolver SELECT is faster and avoids OCC contention.
- **Patient compartment Option A (one row per Patient, all resources denormalized).** Rejected — row size unbounded; fails on heavy patients and healthcare-provider scale.
- **Patient compartment Option D alone (pre-rendered files only).** Rejected — breaks read-your-writes for the Patient compartment endpoints.
- **Cached read tier (Redis-shaped).** Rejected — Postgres-mirror antipattern in different dress; reintroduces a stateful tier with its own consistency story.
- **Client-supplied FHIR IDs honored on create.** Rejected for v1 — server-assigned UUID v7 keeps identity policy clean; clients use Conditional Update by business identifier for idempotency.
- **Unpartitioned high-volume tables.** Rejected — measured session-009 OCC ceiling of ~1.3 writes/sec is fatal at 10M-member ingest rates.
- **Single time-partition keys (no member-hash buckets).** Rejected for the highest-volume tables — single-month partitions concentrate contention into one bucket during peak windows.

## Follow-up ADRs queued

- **ADR-0011: Write contract** — interactive (micro-batch coordinator) + bulk (Spark/Python pipeline) physical paths. Drafted in parallel with this ADR.
- **Search execution model ADR (queued 0005)** — how search parameters beyond identifier hit Layer 2/2b plus Layer 1, given the partition strategy.
- **Operability / ops ADR** — schema migration procedure, OPTIMIZE/VACUUM scheduling, Layer 4b cluster sizing, monitoring, alerting. Probably one comprehensive ops ADR covering everything operational.
- **v1 conformance targets ADR** — US Core version pin (6.x vs 7.x), priority resource set, Inferno scope.
- **Hard-delete / GDPR right-to-be-forgotten** — if customer requirements demand it.
- **Patient compartment refresh policy tuning** — Layer 4b active-window definitions, per-deployment overrides.
- **v2 migration triggers** — when does Ronin move the interactive write path to delta-rs, or split the storage into multiple warehouses?

## Open questions not closed by this ADR

- **Schema migration procedure** for evolving Layer 1 tables under live writes. Belongs in operability.
- **Member-hash-bucket count tuning under healthcare-provider workloads.** Default 64 is a starting point; 128–256 likely for IDN-scale customers. Operability concern; revisited per-deployment.
- **Layer 4b active/cold window definitions.** 15-min active / 24h cold are starting points per Option G. Per-deployment configurable; customer-specific tuning belongs in ops.
- **DLT pipeline orchestration topology.** Streaming pipelines for Layer 3 / Layer 4a (CDF-driven) vs. Layer 4b (NDJSON-rendering): are they one job, multiple jobs, per-resource-type? Belongs in the operability ADR / ingest-tier observability note.

---

## Amendment 1 — Bronze tier + medallion mapping (2026-06-19, session 014)

Per the [Bronze→Silver Governance research note](../research/2026-06-19-bronze-to-silver-governance.md), this ADR is amended to introduce a Bronze tier above the existing layered structure and to align the layer numbering with medallion vocabulary.

### Motivation

The original ADR placed `member_id` as a write-time-stamped column on Layer 1 (§2.5). That treatment was incorrect: `member_id` (now renamed `patient_id` — see change 5) is the *output* of MPI, not a source field, and MPI is a Governance activity that runs after the raw write lands. A Bronze→Silver tier split is therefore required:

- **Bronze** is raw landing — what the client or bulk worker sent, no resolution applied.
- **Silver** is governed canonical FHIR — `patient_id` resolved, profile-validated, identifiers normalized, references resolved.

The existing Layer 2 / 2b / 3 / 4 are properly **Gold** — they are the read-optimized projections that serve the API. The layer numbering is retained; the medallion mapping is documented for vocabulary alignment with the architecture diagram and the research note.

### Changes

**1. New Layer 0 — Bronze raw tables**

One Delta table per `(resource_type, fhir_version)` in a Bronze schema (e.g., `ronin_<warehouse>.bronze.patient_r4`). Append-only. Schema:

```
ingest_id            STRING        -- UUID v7 per write; primary identity at Bronze
ingested_at          TIMESTAMP     -- when the row landed; partition driver
ingest_source        STRING        -- "interactive_http" | "import_worker" | "sftp_drop"
ingest_request_id    STRING        -- correlates with $import_jobs / batch handle
http_session_id      STRING        -- correlates with interactive client session (NULL for bulk)
raw_body             STRUCT<...>   -- dbignite-shaped body, as received
incoming_identifiers ARRAY<STRUCT<system, value, type, use, period>>  -- denormalized from raw_body for cheap MPI lookups
incoming_references  ARRAY<STRUCT<path, reference, identifier, type>> -- denormalized for cheap Governance lookups
validation_status    STRING        -- "pending" until Governance touches the row
fhir_version         STRING
```

Partitioned by `(day(ingested_at), ingest_source)`. No `patient_hash_bucket` — Bronze does not have `patient_id`.

**2. Bronze-side transactional support tables**

To honor the synchronous FHIR REST contract (Conditional Create/Update, idempotency, optimistic concurrency) at write time without depending on Gold's lagged projections, Bronze owns three local support tables:

- `bronze_identifier_shortcut` — keyed by `(identifier_system, identifier_value, resource_type)`. Carries the best-known Ronin `fhir_id`, a `provisional` flag, and `superseded_by` (non-NULL after Governance merges this entry into another). Fed by Bronze writes (provisional rows) and the Gold → Bronze reconciliation pipeline (authoritative updates).
- `bronze_idempotency_cache` — TTL-bounded. Keyed by client `Idempotency-Key` header, bulk-worker `(batch_id, offset)`, or `If-None-Exist` search-criteria fingerprint.
- `bronze_version_cache` — latest `version_id` per `(resource_type, fhir_id)` for `If-Match` optimistic concurrency. Fed by Silver CDF.

See ADR-0011 Amendment 1 and the research note §"Bronze transactional services" for the full design and rationale.

**3. Layer 1 restated as Silver**

The schema in §2.1 ("Layer 1 — Resource tables") is now the **Silver** tier. Naming: `ronin_<warehouse>.silver.<resource_type>_<fhir_version>` (replacing the original `gold` schema reference in §2.1; the original choice predated medallion vocabulary alignment). Schema additions:

```
bronze_ingest_id     STRING        -- foreign key to source Bronze row(s); many-to-one when Governance dedupes
governed_at          TIMESTAMP     -- when the Silver row was written by Governance
governance_pipeline  STRING        -- pipeline version (for audit + reprocessing)
```

`patient_id` (renamed from `member_id` — see change 5) is populated by Governance, not at write time. NULL for resources outside any Patient compartment.

**4. Layer 2 / 2b / 3 / 4 mapped to Gold**

The existing projections are read-optimized views. Medallion vocabulary mapping:

- Layer 2 (`identifier_index`) → Gold
- Layer 2b (`references_index`) → Gold
- Layer 3 (current-version projection) → Gold
- Layer 4a + 4b (Patient compartment) → Gold

Naming: `ronin_<warehouse>.gold.identifier_index`, `ronin_<warehouse>.gold.references_index`, Layer 3 tables under `ronin_<warehouse>.gold.<resource_type>_<fhir_version>_current`, Layer 4a under `ronin_<warehouse>.gold.patient_compartment_<resource_type>_<fhir_version>`, Layer 4b NDJSON volume under `/Volumes/<catalog>/gold/patient_compartments/...`. Layer numbering retained for internal continuity.

**5. `member_id` → `patient_id` rename**

Applied throughout this ADR and the broader documentation. Affects:
- §2.1 schema column (Silver tier under this amendment)
- §2.5 (rewritten — see change 6)
- §3 partition strategy: `member_hash_bucket(fhir_id)` → `patient_hash_bucket(patient_id)` for Claim, EOB, Observation, Encounter, and Layer 4a tables
- §3 `patient_r4` / `patient_r5` partition key uses `patient_hash_bucket(fhir_id)` since the Patient resource's `fhir_id` is its own `patient_id`
- Layer 4a key: `(member, resource_type, fhir_version)` → `(patient_id, resource_type, fhir_version)`
- Layer 4b file naming: `{member_id}.ndjson` → `{patient_id}.ndjson`

Rationale: `member_id` is payer-specific; `patient_id` aligns with FHIR's compartment model and is healthcare-provider-ready (per the ADR-0008 vision of moving beyond payer-only deployments).

**6. §2.5 rewritten**

The original §2.5 stated that `member_id` is "Populated at write time by the resolver, before the row enters the micro-batch coordinator's queue." This is no longer correct. Replacement:

> **§2.5 `patient_id` resolution.** Silver-tier resource rows whose resource has a Patient compartment membership carry a denormalized `patient_id` column (the Ronin-internal Patient `fhir_id`). Populated by Governance during Bronze→Silver promotion, after MPI resolves the incoming Patient identifier or reference. NULL for resources outside any Patient compartment (Organization, Practitioner, etc.). Bronze rows do not carry `patient_id`; the synchronous Bronze-tier Conditional resolution uses `bronze_identifier_shortcut` (change 2) instead.

**7. §6 replaced**

The original §6 ("Synchronous projection updates within the micro-batch coordinator") asserted that identifier_index, references_index, and Layer 4a updates land in the same commit as the source Layer 1 write. Replacement:

> **§6. Tier-write semantics.**
>
> - **Bronze**: synchronous within the interactive write path's micro-batch commit window (per ADR-0011 Amendment 1). The Bronze-local support tables (`bronze_identifier_shortcut`, `bronze_idempotency_cache`) update in the same commit as the Bronze row. Bulk-path Bronze writes are batched Spark commits.
> - **Silver**: governed by the DLT Governance pipeline reading Bronze CDF. Streaming, eventually consistent relative to Bronze (seconds to minutes; bounded by pipeline cadence).
> - **Gold (Layer 2, 2b, 3, 4a)**: streamed from Silver CDF via DLT pipelines. Eventually consistent relative to Silver.
> - **Gold (Layer 4b NDJSON files)**: refreshed asynchronously per the original cadence — 15-min active, daily cold.
> - **Gold → Bronze feedback**: Gold writes feed a reconciliation pipeline that updates `bronze_identifier_shortcut.provisional` / `superseded_by` and `bronze_version_cache`. Streaming, eventually consistent.

The read-your-writes contract is updated accordingly — see ADR-0011 Amendment 1.

### Consequences of this amendment

- The session-013 POC 1 result (Layer 4a synchronous maintenance was infeasible) is moot under this design. Layer 4a is now Gold, streamed from Silver, never synchronously maintained from the write path. The POC's underlying measurements (single-INSERT latency ~1.5s p50) still bound the Bronze write floor.
- The Bronze-side support tables introduce three new write streams per interactive commit (Bronze row + identifier shortcut row + optional idempotency row). All three are append-only and partitioned separately; OCC contention is per-table.
- The Gold → Bronze reconciliation pipeline is a new operational component. Its shape (streaming CDF vs. periodic job) is research-note open question #12 and needs a small POC.
- The architecture diagram (`docs/diagrams/ronin-architecture-e2e.svg`) was updated in this amendment cycle to show the Gold → Bronze feedback edge as a dotted return arrow.
- ADR-0011 is amended in parallel (Amendment 1) to reflect that the interactive write path writes Bronze, not Layer 1/Silver.

### Status

This amendment is **Accepted** and supersedes §2.5 and §6 of the original ADR. The original §2.1 schema is retained as the Silver-tier schema under change 3. All other sections (Layer 2/2b/3/4 designs, partition strategy with `patient_hash_bucket` rename, OPTIMIZE/VACUUM policy, UUID v7 IDs, append-only-over-MERGE, soft-delete semantics) stand as written.

> **Note (Amendment 2 below):** The "Silver" tier introduced by Amendment 1 was a vocabulary alignment more than a structural change. Amendment 2 collapses Silver back into Gold — Layer 1 canonical resource tables become **Gold** alongside Layer 2/2b/3/4 projections. Read the two amendments together: Amendment 1 introduced Bronze; Amendment 2 simplifies the rest of the tier model.

---

## Amendment 2 — Silver→Gold collapse (2026-06-19, session 014)

Per Chad's session-014 call ("My instinct is to land data in bronze, then do the matching, and immediately push to gold") and the [Ronin MPI design research note](../research/2026-06-19-ronin-mpi-design.md), this amendment collapses the Silver tier introduced by Amendment 1 back into Gold. The result is a two-tier model with a single Governance transformation between them.

### Motivation

Amendment 1 introduced Silver as a distinct tier to separate "governed canonical FHIR" from "read-optimized projections." On reflection this split is more vocabulary than structure for an operational FHIR server. The traditional medallion three-tier model assumes Silver is a heavy ELT/transform layer and Gold is a lightweight aggregation tier. For Ronin, the heavy work is the Bronze→Governance→canonical transformation; the projections (`identifier_index`, `references_index`, current-version, Patient compartment) are query optimizations over the canonical truth, not a separate business-semantics tier. Naming the canonical resource tables Silver and the projections Gold blurs that — both are read-side, both are streaming from Bronze via Governance, both are eventually consistent. Two physical tiers (Bronze + Gold) match the operational reality more honestly than three.

### Changes

**1. Layer 1 canonical resource tables move to Gold.**

The schema introduced by Amendment 1 change 3 (under the Silver label) now lives in Gold. Naming changes from `ronin_<warehouse>.silver.<resource_type>_<fhir_version>` to `ronin_<warehouse>.gold.<resource_type>_<fhir_version>`. Schema is unchanged:

```
fhir_id              STRING
version_id           BIGINT
last_updated         TIMESTAMP
fhir_version         STRING
source               STRING
profile              ARRAY<STRING>
security             ARRAY<STRUCT<system, code, display>>
tag                  ARRAY<STRUCT<system, code, display>>
deleted              BOOLEAN
patient_id           STRING        -- Governance-output; NULL outside Patient compartment
body                 STRUCT<...>   -- vanilla dbignite body
bronze_ingest_id     STRING        -- foreign key to source Bronze row(s)
governed_at          TIMESTAMP
governance_pipeline  STRING
ingest_source        STRING
```

The canonical resource tables and the projections are now **sibling Gold tables**. Layer numbering (Layer 1 = canonical resource tables, Layer 2 = identifier_index, etc.) is retained for internal continuity; medallion labeling is "all Gold."

**2. Layer numbering with collapsed tiers.**

- Layer 0 — Bronze raw landing (per Amendment 1 change 1).
- Layer 1 — Gold canonical resource tables (this amendment; was Silver under Amendment 1).
- Layer 2 — Gold `identifier_index` (per Amendment 1 change 4).
- Layer 2b — Gold `references_index` (per Amendment 1 change 4).
- Layer 3 — Gold current-version projection (per Amendment 1 change 4).
- Layer 4a — Gold Patient compartment per-row (per Amendment 1 change 4).
- Layer 4b — Gold Patient compartment NDJSON files (per Amendment 1 change 4).

Plus Bronze-side support tables introduced by Amendment 1 change 2 (`bronze_identifier_shortcut`, `bronze_idempotency_cache`, `bronze_version_cache`). MPI tables added by ADR-0012 (`gold.patient_link`, `gold.patient_match_review`, `gold.patient_merge_history`, `gold.pprl_tokens`) are all Gold-tier.

**3. §6 ("Tier-write semantics" as replaced by Amendment 1) updated.**

The Amendment 1 §6 replacement referenced a Silver tier between Bronze and Gold. Replacement under this amendment:

> **§6. Tier-write semantics (Amendment 2 version).**
>
> - **Bronze**: synchronous within the interactive write path's micro-batch commit window (per ADR-0011). Bronze-side support tables update in the same commit as the Bronze row. Bulk-path Bronze writes are batched Spark commits.
> - **Gold (Layer 1 canonical resource tables)**: governed by the customer-side DLT Governance pipeline reading Bronze CDF. Streaming; eventually consistent relative to Bronze (seconds to minutes; bounded by pipeline cadence).
> - **Gold (Layer 2, 2b, 3, 4a)**: streamed from Layer 1 (Gold canonical) via Delta CDF → DLT pipelines. Eventually consistent relative to Layer 1.
> - **Gold (Layer 4b NDJSON files)**: refreshed asynchronously per the original cadence — 15-min active, daily cold.
> - **Gold → Bronze feedback**: Gold writes feed a reconciliation pipeline that updates `bronze_identifier_shortcut.provisional` / `superseded_by` and `bronze_version_cache`. Streaming; eventually consistent.

The flow is **one tier transition with two streaming hops inside Gold** (Layer 1 → Layer 2/2b/3/4a; Layer 4a → Layer 4b refresh).

**4. Diagram update.**

The architecture diagram (`docs/diagrams/ronin-architecture-e2e.svg`) needs the Silver cylinder dropped. Bronze stays at the bottom; Gold at the top; Governance box on the Customer side still does the same work. The Gold→Bronze feedback arrow stays. Update follows in the same amendment cycle.

**5. `bronze_ingest_id` semantics.**

Under Amendment 1, `bronze_ingest_id` was a foreign key to Bronze on the Silver row. It stays — now on the Gold canonical row directly. Many-to-one when Governance dedupes within a batch (multiple Bronze rows produce one Gold row); one-to-one otherwise. The mapping is unchanged.

### Consequences of this amendment

- Mental model simplifies: Bronze (raw + transactional) → Governance (the work) → Gold (canonical + projections). Two tiers, one transformation step.
- ADR-0011 needs a companion Amendment 2 (interactive + bulk write paths target Bronze; Governance promotes to Gold; no Silver intermediate). Drafted in parallel.
- ADR-0012 (MPI) is built on this collapsed tier model from the start.
- All MPI tables (per ADR-0012) live in Gold — `gold.patient_link`, `gold.patient_match_review`, `gold.patient_merge_history`, `gold.pprl_tokens`.
- The Bronze→Silver Governance research note ([2026-06-19](../research/2026-06-19-bronze-to-silver-governance.md)) still describes the Governance activities correctly; only the tier labels in that note's §"The three tiers" section drift. Worth a small follow-up edit; not blocking.
- No partition, OPTIMIZE/VACUUM, ID, or append-only-over-MERGE semantics change. Operational footprint is unchanged.
- Schema naming changes (`silver.<...>` → `gold.<...>`) are pre-v1; no migration concern.

### Status

This amendment is **Accepted** and supersedes Amendment 1 change 3 (Silver tier label), Amendment 1 change 4 (Layer 2/2b/3/4 → Gold; carried forward), and Amendment 1 §6 replacement (re-replaced above). All other Amendment 1 changes (Layer 0 Bronze, Bronze support tables, member_id→patient_id rename, §2.5 rewrite) stand as written.

> **Note (Amendment 3 below):** Session-018 work on the validation architecture surfaced substantive distinct work that lives between Bronze and Gold — assembled-resource validation, DQ rules, DAR fill, MPI resolution, manual review holding. Amendment 3 walks back Amendment 2's Silver→Gold collapse and reinstates Silver as a substantive tier. Read all three amendments together: Amendment 1 introduced Bronze; Amendment 2 prematurely collapsed Silver; Amendment 3 restores it with real substance behind it.

---

## Amendment 3 — Silver reinstated as substantive governance-staging tier (2026-06-19, session 018)

Per the [validation architecture research note](../research/2026-06-19-validation-architecture.md), Silver returns as a substantive tier between Bronze and Gold. The session-014 Amendment 2 collapsed Silver into Gold because Silver looked like vocabulary not substance. Session-018 validation-architecture work made clear what Silver does:

- **Assembled-resource validation** (slicing across profile claims, profile-of-a-profile inheritance, cross-field invariants, residual HL7 Validator surgical use).
- **DQ rules + Data Absent Reason (DAR) fill** — clinical plausibility, value ranges, temporal consistency, identifier format, terminology freshness. Fills DAR per per-IG default policy (BP 400/500 example: clinical-reference-range rule flags out-of-range; disposition `warn-with-DAR-fill` applies `_dataAbsentReason.code='error'` and preserves the original value in an extension).
- **MPI resolution** — Patient match decisions land here; multi-match `review_required` rows hold in Silver per ADR-0012 §5.
- **Manual review holding** — rows that need steward eyes sit in Silver flagged.

Silver is **the work-in-progress tier**; rows are held until they pass the blessing check before promotion to Gold. **Gold remains the canonical enterprise FHIR store** plus its read projections — the source of truth.

### Changes

**1. Silver reintroduced as a Delta tier.**

Per `(resource_type, fhir_version)`, in a Silver schema (e.g., `ronin_<warehouse>.silver.patient_r4`). Append-only. Schema per validation-architecture note §4:

```
silver_id            STRING        -- UUID v7
bronze_ingest_id     STRING        -- FK to Bronze
fhir_id              STRING        -- resolved Ronin fhir_id (after MPI)
patient_id           STRING        -- resolved by Governance (MPI output)
version_id           BIGINT
fhir_version         STRING
silver_status        STRING        -- 'pass' | 'review_required' | 'rejected'
manual_review_id     STRING
governed_at          TIMESTAMP
governance_pipeline  STRING
body                 STRUCT<...>   -- dbignite body, DAR-filled
validation_state     STRUCT<field_checks, assembled_checks, dq_outcomes, dar_fills,
                            hl7_validator_used, hl7_validator_outcome,
                            unresolved_references>
audit_trail          ARRAY<STRUCT<phase, timestamp, actor, decision>>
```

Partitioned by `(silver_status, year_month(governed_at))`. Active staging-and-review subset lives in `silver_status='review_required'` partitions; promoted rows roll off into historical partitions after Gold promotion. Retention policy: `silver_status='pass'` rows default 30-day Silver retention after Gold promotion (configurable; supports replay + audit).

**2. Gold restated as canonical-plus-projections (the enterprise FHIR store).**

Amendment 2's "Layer 1 canonical resource tables" framing stands — they live in Gold and they ARE the canonical truth. Gold is now:

- **Gold Layer 1**: canonical resource tables (the truth; what FHIR APIs serve). Fed from Silver `silver_status='pass'` blessing.
- **Gold Layer 2 / 2b / 3 / 4**: read projections (identifier_index, references_index, current-version, Patient compartment). Stream from Gold Layer 1 via CDF.
- **Gold MPI tables** (per ADR-0012): patient_link, patient_match_review, patient_merge_history, pprl_tokens, mpi_decision_log.
- **Gold AuditEvent serving** (per CMS-2027 compliance note §4): AuditEvent resource tables.
- **Gold terminology** (per foundations note §4.1): code systems, value-set expansions, concept maps.

Gold is **the source of truth**. Bronze is the raw landing audit. Silver is the work-in-progress staging.

**3. Layer numbering.**

- Layer 0 — Bronze raw tables + Bronze transactional support tables (per Amendment 1).
- **Layer 0.5 — Silver tables** (this amendment) — per-`(resource_type, fhir_version)` governance-staging.
- Layer 1 — Gold canonical resource tables.
- Layer 2 — Gold `identifier_index`.
- Layer 2b — Gold `references_index`.
- Layer 3 — Gold current-version projection.
- Layer 4a — Gold Patient compartment per-row.
- Layer 4b — Gold Patient compartment NDJSON files.
- Plus Gold MPI tables (per ADR-0012), Gold AuditEvent serving (per CMS-2027 note), Gold terminology (per foundations note).

**4. §6 ("Tier-write semantics" as replaced by Amendment 2) replaced again.**

Replacement:

> **§6. Tier-write semantics (Amendment 3 version).**
>
> - **Bronze**: synchronous within the interactive write path's micro-batch commit window. Bronze-side support tables update in the same commit as the Bronze row. Per-field SQL checks run inline; `field_checks` struct captured on the Bronze row. `silver_eligible` flag set per check outcome.
> - **Silver**: governed by the customer-side DLT Governance pipeline reading Bronze CDF. Performs assembled-resource validation (slicing + invariants + residual HL7 Validator), DQ rules + DAR fill, MPI resolution, reference resolution. Streaming; eventually consistent relative to Bronze (seconds to minutes; bounded by pipeline cadence).
> - **Gold (Layer 1 canonical resource tables)**: blessed by the Silver→Gold promotion DLT pipeline. Streams from Silver CDF; only `silver_status='pass'` rows promote. Eventually consistent relative to Silver.
> - **Gold (Layer 2 / 2b / 3 / 4a)**: streamed from Layer 1 via Delta CDF → DLT pipelines. Eventually consistent relative to Layer 1.
> - **Gold (Layer 4b NDJSON files)**: 15-min active / daily cold refresh.
> - **Gold (MPI / AuditEvent / terminology tables)**: see ADR-0012, CMS-2027 note, foundations note.
> - **Gold → Bronze feedback**: streaming reconciliation back into Bronze caches (per Amendment 1 §2.2; unchanged).

**5. Architecture diagram update.**

The architecture diagram (`docs/diagrams/ronin-architecture-e2e.svg`) gets the Silver cylinder re-added between Bronze and Gold. The Customer-side Governance box continues to drive Bronze→Silver; a new Silver→Gold blessing arrow shows the promotion step. Gold→Bronze feedback stays.

### Consequences of this amendment

- Three-tier model returns. Bronze (audit) → Silver (work-in-progress) → Gold (truth + serving). More honest about the operational reality.
- Storage cost increases (Silver duplicates canonical body before Gold promotion). 30-day default Silver retention after Gold promotion bounds the cost; configurable.
- Read-your-writes contract: Bronze synchronous; Silver eventually consistent vs Bronze; Gold eventually consistent vs Silver. Two-hop eventual consistency for read paths. ADR-0011 Amendment 3 (companion) covers the implications.
- ADR-0012 MPI tables stay in Gold (final destination); MPI resolution happens during Bronze→Silver Governance.
- Reprocessing semantics: Bronze rows can be replayed through Silver→Gold when validation rules change (per validation-architecture note §6). Each replay is idempotent; Silver and Gold rows accumulate append-only.
- Manual review rows (Silver `silver_status='review_required'`) stay in Silver, never promote to Gold. Steward decisions flip them to `pass` or `rejected`, which triggers Gold promotion or final rejection.

### Status

This amendment is **Accepted** and supersedes Amendment 2 changes 1 and 2 (Layer 1 → Gold collapse), Amendment 2 §6 replacement (re-replaced above), and clarifies Amendment 2 change 4 (Layer 2/2b/3/4 stays Gold as projections of Gold Layer 1; unchanged). All Amendment 1 changes stand. The pre-Amendment-2 framing (Silver tier exists) is restored, with substantive distinct work attached to it.

---

## Amendment 4 — dbignite flattened tables + soft-delete + Silver build (2026-06-27, session 029)

The M1/M2 implementation deviated from §1: every Bronze/Gold table stored the
resource body as a single `body_json STRING` blob, with no dbignite `body
STRUCT<...>` and no discrete per-attribute columns — and the §8 soft-delete
tombstone was never implemented (the server hard-`DELETE`d the Gold row). This
amendment ratifies how §1 and §8 are actually realized in the TS server tier.

### Changes

**1. Bronze resource tables ARE the dbignite tables — flattened, one top-level
column per FHIR element.**

§1's "vanilla dbignite" body means dbignite's actual table shape: one Delta
table per resource type whose columns ARE the FHIR elements. So each Bronze
resource table (`bronze.patient_r4`, `bronze.coverage_r4`, …) carries a
top-level column per FHIR element — `id`, `meta`, `identifier`, `name`,
`gender`, `birthDate`, … (plus the `_field` primitive-extension siblings) —
so `SELECT birthDate FROM bronze.patient_r4` returns a single value per row.
These columns are populated at write time from `body_json` via Spark
`from_json(body_json, <schema>)`, parsed once and projected field-by-field.

`body_json STRING` is retained alongside the flattened columns as the exact
source-of-truth (the dbignite roundtrip is not byte-exact — it drops
`resourceType` and collapses References to strings), plus the operational
columns (`fhir_id`, `version_id`, `last_updated`, `identifier_index`,
`ext_json`, `deleted`, `_ingested_at`, `_ingest_source`).

**2. Gold current-version tables stay the read/serving projection — NOT the
dbignite-flattened shape.**

Gold keeps `body_json` (the REST read path returns it verbatim — zero
fidelity risk) + the purpose-built denormalized columns for compartment and
temporal queries (`beneficiary_id`, `patient_id`, `status`, `recorded`,
`period_start`, …) + SLS columns. Gold is deliberately NOT flattened to the
dbignite columns: those denorm columns collide by name *and type* with FHIR
field names (`AuditEvent.action`, `AuditEvent.recorded` TIMESTAMP vs dbignite
STRING, `Provenance.recorded`, `Coverage.status`, `EOB.use/outcome`). Bronze
is the canonical dbignite resource table; Gold is the query projection over
it. (Matches the medallion split: Bronze raw/canonical, Gold read-optimized.)

**3. dbignite schemas vendored with `metadata` stripped; columns from the
registry.**

Per-resource dbignite r4 `StructType.json()` schemas are vendored at
`src/fhir-schema/dbignite/r4/*.json` and served by
`src/fhir-schema/dbignite-registry.ts` (`dbigniteSchemaJson`,
`dbigniteColumns`, `dbigniteFieldNames`). The only transform vs. upstream is
emptying every `metadata` block — FHIR `path`/`description` metadata is
irrelevant to the Spark data type and pushes the schema past the SQL parse
ceiling when inlined as a `from_json` literal (Patient: 213 KB raw fails;
49 KB stripped works). Data-type semantics are unchanged. `schema-apply.ts`
expands the Bronze `${DBIGNITE_COLUMNS}` placeholder from the registry, so the
column definitions and the write-time `from_json` field order agree. dbignite
quirks preserved: no `resourceType` field (read re-stamps it), References are
scalar strings, `_field` siblings kept.

**4. Soft-delete tombstone (realizes §8) implemented.**

A `deleted BOOLEAN` column is added to every Bronze and Gold resource table.
`DELETE` now appends a new version row with `deleted=true` (Bronze history +
Gold current-version MERGE), preserving the body. The current-version Gold
row carries `deleted=true`; `GET` → 410 Gone (vs. 404 never-existed);
identifier searches filter `deleted=false OR deleted IS NULL` (NULL =
legacy/not-deleted). `_history`/Bronze retains the full version chain
including the tombstone. Hard-delete remains out of v1 scope (§8).

**5. Silver tier built (realizes Amendment 3).**

Amendment 3 reinstated Silver as a substantive governance-staging tier but no
Silver DDL was ever created (only `bronze` + `gold` schemas existed). It is now
built: `sql/silver/<resource>_r4.sql`, deployed by `schema-apply.ts` (Bronze →
Silver → Gold). Each Silver table is **structurally like Bronze** — the
dbignite flattened resource table (`${DBIGNITE_COLUMNS}` + `body_json` +
`identifier_index`) — **plus** the non-FHIR governance/processing metadata
columns from A3 §4.1 (`silver_id`, `bronze_ingest_id`, `fhir_id`, `patient_id`,
`version_id`, `fhir_version`, `silver_status`, `manual_review_id`,
`governed_at`, `governance_pipeline`, `validation_state STRUCT<…>`,
`audit_trail ARRAY<STRUCT<…>>`). This refines A3 §4.1's single `body STRUCT<…>`
to the flattened-columns shape (consistent with Bronze; change 1). No writer in
v1 — Silver is the DLT Governance tier (M4, Bronze CDF → Silver); the tables
are created so the structure exists.

### Consequences

- `SELECT birthDate FROM bronze.patient_r4` (and every other FHIR element)
  works — the original §1 intent, verified against a live warehouse.
- Storage overhead in Bronze: the body is materialized as flattened columns
  *and* `body_json`. Acceptable for v1; the flattened columns are the
  SQL-on-FHIR / analytics surface, `body_json` is the exact source-of-truth.
- Per-write cost: the schema literal (49 KB–297 KB, EOB largest) is inlined in
  each Bronze INSERT. Fine for v1 interactive volumes; a registered-function
  or prepared-statement optimization is a later option.
- Gold compartment/search SQL for resource-specific queries (Coverage
  `activeAsOf`, EOB `findByPatient`, …) does not yet carry an explicit
  `deleted=false` filter — read→410 and identifier search are covered; broaden
  before M6 if soft-deleted compartment members must drop out of `$everything`.
- The Python ingestion tier (M4) producing the dbignite Bronze tables via
  Spark directly is the bulk-path counterpart; this amendment covers the
  interactive TS path.

### Status

**Accepted.** Realizes §1 (dbignite flattened resource tables in Bronze), §8
(soft-delete), and the Amendment 3 Silver tier (built, flattened + governance
metadata) in the operational TS tier; supersedes the M1 `body_json`-only
schema. Verified: 337 in-memory + 45 Databricks integration tests green; 16
tables deployed (5 Bronze + 5 Silver + 6 Gold).
