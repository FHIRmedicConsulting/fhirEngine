# ADR-0011: Write Contract — Interactive (TS + Micro-Batch) and Bulk (Python/Spark) Physical Paths

- Status: **Accepted** · Amended 2026-06-19 (A1: Bronze transactional services; A2: Silver→Gold collapse; A3: Silver reinstated; Bronze → Silver → Gold flow)
- Date: 2026-06-19
- Decider(s): Chad
- Session: 011 (original), 014 (Amendments 1+2), 018 (Amendment 3)
- Related: [ADR-0008](0008-updated-vision-and-scope.md), [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md), [ADR-0010](0010-storage-shape.md), [ADR-0012](0012-master-patient-index.md), [ADR-0013](0013-deployment-posture.md), [docs/research/2026-06-17-polyglot-write-contract.md](../research/2026-06-17-polyglot-write-contract.md), [docs/research/2026-06-18-microbatch-write-path.md](../research/2026-06-18-microbatch-write-path.md), [docs/research/2026-06-18-payer-volume-sizing.md](../research/2026-06-18-payer-volume-sizing.md), [docs/research/2026-06-18-import-status-protocol.md](../research/2026-06-18-import-status-protocol.md), [docs/research/2026-06-19-bronze-to-silver-governance.md](../research/2026-06-19-bronze-to-silver-governance.md), [docs/research/2026-06-19-ronin-mpi-design.md](../research/2026-06-19-ronin-mpi-design.md), [docs/research/2026-06-19-validation-architecture.md](../research/2026-06-19-validation-architecture.md)

## Context

The polyglot write contract research note (`docs/research/2026-06-17-polyglot-write-contract.md`) evolved through sessions 006–010. The session-009 POC produced the first real latency numbers; the session-010 sizing model and positioning review forced an architectural split: the "one write path, three triggers" framing held at FHIR semantics but failed at physical mechanics for Ronin's "big and fast for ingestion" target. The note now stands as "one FHIR semantics layer, two physical write paths."

[ADR-0010](0010-storage-shape.md) ratifies the storage layer those paths write to: vanilla dbignite body schemas, append-only resource tables (partitioned), three derived projections (identifier_index, references_index, current-version), and the materialized Patient compartment.

This ADR ratifies how data physically lands in that storage. Two paths: interactive via the TS server's micro-batch coordinator using the Databricks SQL Driver, and bulk via Python/Spark workers using Spark DataFrame batch writes. Both share FHIR semantics (Conditional Update by business identifier, append-only versioning, projection updates, audit) implemented in shared libraries.

## Decision

### 1. Two physical write paths, one FHIR semantics layer

**Interactive write path:** TypeScript REST server's HTTP handlers (interactive HTTP triggers + transaction Bundle deconstruction) → micro-batch coordinator → Databricks SQL Driver for Node.js (`@databricks/sql`) → serverless SQL Warehouse → Delta tables in UC. Volume profile: tens of req/sec at peak; sub-2s latency per request acceptable.

**Bulk write path:** Python/Spark workers (`$import` async ingestion + SFTP file-drop ingest) → Spark DataFrame batch writes → Delta tables in UC. Volume profile: 12–20 writes/sec sustained, 500–2000/sec burst; per-resource cost amortized over thousands of rows per commit.

Same FHIR semantics across both: Conditional Update by business identifier (resolver → identifier_index → decide create/update/ambiguous → append new version row); append-only versioning with monotonic `version_id`; projection updates (identifier_index, references_index, Layer 4a Patient compartment); error reporting via OperationOutcome NDJSON files.

The shared FHIR semantics live in a **shared write-path library** consumable from both runtimes:
- TS implementation in the TS server's persistence layer.
- Python implementation in the Spark worker codebase.
- **Both consume the same canonical specifications** (dbignite schemas, FHIR Schema, US Core profiles, identifier-system normalization rules, conditional-reference policy). Implementation drift is prevented by lockstep code review and shared integration tests against the same FHIR test fixtures, not by sharing a single binary.

### 2. Interactive write path — micro-batch coordinator on the SQL Driver

Per the [micro-batch sketch](../research/2026-06-18-microbatch-write-path.md) and validated by the session-009 POC numbers:

- One in-process micro-batch coordinator per TS-server replica.
- Single-resource interactive HTTP triggers and transaction Bundle entries enqueue ops onto the current batch.
- **Flush triggers:** `N = 100` rows OR `T = 25–50 ms` since batch open, whichever first. Configurable per deployment.
- **Flush mechanism:** one multi-row `INSERT INTO …gold.<resource>_<ver> VALUES (…), (…), …` statement issued via `@databricks/sql` against a serverless SQL Warehouse. Read-your-writes: each op's awaiting handler blocks until the batch commit succeeds.
- **Projection updates** (identifier_index, references_index, Layer 4a compartment row) land **in the same batch / commit** as the source resource row. Synchronous; the resolver-read correctness guarantee depends on it.
- **Conditional Update flow:** resolver `SELECT` against `identifier_index` runs **before enqueue** (one round-trip outside the batch); decision (create / update / ambiguous) determined; on create, server generates UUID v7 `fhir_id`; on update, server reads `MAX(version_id)` for that `fhir_id` from current-version projection; new row enqueued. No MERGE statement is ever issued on the interactive path (per ADR-0010 §7).
- **Transaction Bundle:** the bundle's N entries form **one dedicated batch** (one bundle = one commit), bypassing the shared time-window. Cross-table failure mid-bundle is the open complexity: each Delta table operation is atomic individually, but cross-table is not full ACID. v1 posture: accept FHIR's loose semantics (the spec permits "best effort" for some failures); each entry's response carries its own status; partial bundles return a transaction-response Bundle with per-entry outcomes. Robust cross-table transactionality belongs in a future ADR.
- **Intra-batch same-resource collisions:** if two ops in the current batch resolve to the same `fhir_id`, the second is deferred to the next batch (per ADR-0010 §7).
- **PATCH:** basic FHIR-spec semantics for v1; full FHIRPath Patch deferred to v2. v1 PATCH = read current → apply JSON merge patch → enqueue update.

### 3. Bulk write path — Python/Spark workers

Two entry points in v1, three deferred:

#### 3a. `$import` async HTTP kickoff

1. Client posts `POST /fhir/{ver}/$import` to the TS REST server with a manifest (FHIR Parameters resource containing input NDJSON URLs).
2. TS server validates the manifest, generates a `request_id`, writes the job record to `ronin_<warehouse>.system.import_jobs`, and returns `202 Accepted` + `Content-Location: /fhir/{ver}/$import-status/{request_id}`.
3. TS server dispatches the job to the Python/Spark tier via the Databricks Jobs API (long-running pipelines) or a queue mechanism (Databricks Workflows + scheduled task). The Spark side reads the new `import_jobs` row to pick up its work.
4. Spark workers read referenced NDJSON URLs from cloud storage in parallel (Auto Loader or batch DataFrame, depending on file count and size).
5. Per resource: workers transform incoming FHIR JSON to a dbignite-shaped row, run identifier resolution (resolver `SELECT` against `identifier_index` joined to the incoming batch), populate `meta.versionId` and `meta.lastUpdated`, accumulate into Spark DataFrames partitioned by target table.
6. Workers write via `df.write.format("delta").mode("append")`. Thousands of rows per commit; per-resource amortized cost matches POC batch=500 (~6.7ms / resource).
7. Workers update `import_jobs` every ~10,000 resources or ~30 seconds (whichever first).
8. Per-resource errors append to an OperationOutcome NDJSON file at `/Volumes/<catalog>/system/import-errors/{request_id}/<input-file-basename>.errors.ndjson`. Configurable retention (default 7 days per `2026-06-18-import-status-protocol.md` ratified decisions).
9. Completion: workers write the completion manifest into `import_jobs`; subsequent TS status polls return `200 OK` + manifest.

Projection updates on the bulk path are **eventually consistent** via Delta CDF → streaming pipelines (Layer 3 + Layer 4a maintained by DLT, not synchronous in-batch). Lag is bounded by the streaming cadence (~10–60 seconds typically). Bulk-import volume tolerates this.

#### 3b. SFTP file-drop ingest

For partners (clearinghouses, smaller TPAs, lab vendors, PBM partners) who deliver NDJSON / Bundle / proprietary flat files via SFTP without an `$import` kickoff:

1. Partner's SFTP target is a UC Volume mapped to SFTP (or S3 / ADLS / GCS bucket the SFTP server writes to, with UC external location pointing at it).
2. Auto Loader detects new files (via cloud-provider event notification: Event Grid on Azure, S3 Event Notification on AWS, Cloud Storage notifications on GCP).
3. DLT pipeline or scheduled Spark Job triggered; same transformation + write code as `$import` (§3a steps 5–8).
4. No HTTP status URL surfaced (no `$import` kickoff). Operator-facing observability via audit events written to a Ronin audit table and surfaced through a Databricks dashboard.
5. Errors land in the same UC Volume error-file convention; retention 7 days configurable.

#### 3c. Delta Sharing inbound — deferred to post-v1

Partner-managed Delta tables shared to Ronin → Spark Structured Streaming reader → same transformation pipeline. **Not v1** per [ADR-0009 Amendment 4 third revision](0009-databricks-partner-posture-and-adr-0008-corrections.md) and [positioning review](../research/2026-06-19-positioning-review-big-and-fast.md). Architecturally clean to add later because the same transformation pipeline handles `$import` and SFTP today.

#### 3d. 837 / 835 X12 ingest — likely v1.x, not v1

v1 ships generic NDJSON and Bundle parsers only. Partners delivering X12 either convert upstream (clearinghouse-side translation to FHIR) or wait for v1.x. To be confirmed before v1 scope locks.

#### 3e. HL7v2 message feeds — out of scope v1 / v2

Per ADR-0008 D6; deferred indefinitely. Healthcare-provider customers needing HL7v2 ingest run an interface engine (Mirth, Rhapsody, etc.) upstream of Ronin.

### 4. External-loader compatibility

Microsoft's [FHIR-Bulk Loader](https://github.com/microsoft/fhir-loader) (and similar external loaders that POST each resource to FHIR REST endpoints) remain **compatible with Ronin's interactive REST surface** — those POSTs land at the TS server as interactive HTTP triggers and traverse the interactive write path. Per the [`ronin-design-taste`](../../README.md) memory: this pattern is expensive at scale (one HTTP round-trip per resource); Ronin does not ship a loader and recommends the server-side `$import` path or SFTP file drop instead. Customers running existing external-loader infrastructure can point it at Ronin without changes; performance will be limited by HTTP round-trip cost.

### 5. Idempotency

- **Per-resource:** Conditional Update by business identifier is naturally idempotent. The same identifier resolves to the same `fhir_id`; the second write becomes a version update of the first.
- **Per `$import` kickoff retry:** the optional `idempotencyKey` extension on the kickoff (per `2026-06-18-import-status-protocol.md` ratified decisions) — if a kickoff arrives with an `idempotencyKey` already in `import_jobs`, the server returns the existing request's `Content-Location` instead of starting a new job.
- **Per-bundle retry:** transaction Bundles use FHIR's `Bundle.entry.request.ifNoneExist` and `If-Match` headers per spec for conditional-create / conditional-update semantics.

### 6. Authorization on the write paths

Per ADR-0006 (TBD; SMART specifics):

- **Interactive write path:** SMART on FHIR scopes (`user/*.write`, `system/*.write`, resource-type-scoped variants) on the OAuth M2M or U2M token presented at the HTTP handler.
- **`$import` kickoff:** `system/*.write` scope on the OAuth M2M token presented at `POST /$import`. Status URL inherits the kickoff's auth context.
- **SFTP file-drop:** authorization is at the file-system / cloud-storage permission layer (the SFTP user can write to the UC Volume; the Auto Loader job runs under a service principal granted `EXTERNAL USE SCHEMA` on the target tables). No per-record token; the Ronin operator decides what gets routed where via the file-drop staging convention.

Details land in ADR-0006.

### 7. Failure handling

- **Interactive batch commit failure** (warehouse error, transient): all ops in the batch see `5xx`; clients retry. Per-resource idempotency comes from Conditional Update by business identifier.
- **Poison-row isolation:** v1 default is per-batch failure — a single bad row fails its batch's neighbors. Validation runs **before enqueue** so the batch is all-valid by construction (pushes validation upstream of the commit). If a row escapes validation, bisect-and-retry to isolate is a v1.x refinement, not v1.
- **Bulk write path partial failure:** per-input-file granularity. If one input file in the manifest fails, the manifest's `output[]` reports its count and the `error[]` contains the URL of the error NDJSON file. Successfully-processed files remain in the manifest's `output[]`. Per the `$import` spec.
- **Transaction Bundle failure:** the bundle is its own batch; failure rejects the entire bundle. Spec-conformant.

### 8. delta-rs as v2+ migration target

Per [ADR-0009 Amendment 4](0009-databricks-partner-posture-and-adr-0008-corrections.md) and the polyglot write contract research note: when UC managed-Delta external write moves from Beta to GA, **delta-rs / `deltalake-node` becomes the v2+ replacement for the interactive write path**. The SQL Driver path produces ~1.5s p50 commits; delta-rs direct writes are expected to hit 100–300ms for small batches because there's no SQL Warehouse round-trip. Migration trigger: UC managed-Delta external write GA + a successful POC against Ronin's representative workload + a clean fallback (if delta-rs has a regression, fall back to the SQL Driver path within minutes via a config flip).

The interactive write path's design isolates this concern: the micro-batch coordinator is the only thing that issues writes; swapping its underlying driver leaves the rest of the architecture unchanged.

## Consequences

- Two physical write paths require two implementations of shared FHIR semantics. Discipline (shared tests, shared specifications, code review) prevents drift; the cost is real and needs operability investment.
- The interactive write path's latency is ~1.5–2s p50 per request (POC-measured); the bulk write path's amortized per-resource cost is ~6.7ms at batch=500. These are the published latency commitments for v1. Customers needing sub-second interactive writes wait for v2 (delta-rs).
- The `import_jobs` table is a coordination point between the TS server (orchestrator + status URL) and the Spark workers (progress reporter + completion writer). Schema is owned by [ADR-0010](0010-storage-shape.md) (system table); shape is straightforward (request_id, status, input manifest, output manifest, error manifest, started_at, updated_at).
- The bulk write path is the v1 home of all volume; the interactive path serves the four CMS APIs at expected interactive volumes (tens of req/sec). The cost model splits accordingly: bulk path drives ingest-tier cluster sizing; interactive path drives SQL Warehouse cost.
- Transaction Bundle cross-table atomicity gap (per §2) is accepted as v1 posture; robust cross-table transactional semantics belong in a future ADR if customer requirements demand it.
- External-loader pattern compatibility (§4) means customers can adopt Ronin without changing their existing data-pipeline infrastructure, at the cost of suboptimal performance until they migrate to `$import` or SFTP file-drop.

## Alternatives considered

- **Candidate A (delta-rs) for v1 interactive write path.** Rejected — UC managed-Delta external write is in Beta (per Databricks docs verified 2026-06-17); not production-ready for v1's operational hot path. Reconsider when GA.
- **Candidate C (RPC to Python writer) on interactive path.** Rejected — adds Python complexity to the interactive critical path, contradicting ADR-0009's narrow v1 polyglot stance; the extra RPC hop adds 5–20ms baseline latency to every interactive write.
- **Candidate D (queued spool between TS and Delta).** Rejected — breaks read-your-writes for the interactive trigger; commits-before-resolve is the property that makes the micro-batch coordinator viable.
- **Candidate E (Statement Execution API REST).** Rejected — variant of B with worse latency profile.
- **Single write path (TS process runs everything, including `$import` ingest).** Rejected per session-010 positioning review — 10M-member payer ingest volume (500–2000 writes/sec burst) chokes a TS in-process worker; bulk ingest belongs in Spark.
- **External loader as primary bulk path.** Rejected per session-008 + design taste — one HTTP round-trip per resource at scale is expensive on cloud spend and operationally fragile.
- **Synchronous projection updates on the bulk path.** Rejected — bulk volume produces commit storms; streaming via Delta CDF is the natural cadence.
- **Asynchronous projection updates on the interactive path.** Rejected — the resolver reads the identifier projection on every Conditional Update; asynchronous lag would manifest as inconsistent resolution.
- **Cross-table ACID transactions for transaction Bundles.** Deferred — v1 accepts FHIR's loose semantics; revisit if customer requirements demand stronger guarantees.

## Follow-up ADRs queued

- **ADR-0006 SMART on FHIR specifics** — auth grammar, IdP choices, scope handling for interactive and bulk paths.
- **Operability ADR** — schema migration, OPTIMIZE/VACUUM scheduling, DLT cluster sizing, monitoring, alerting, on-call.
- **v1 conformance targets ADR** — US Core version pin, Inferno scope.
- **Transaction Bundle cross-table semantics** — if customers ask for full ACID; current posture is FHIR-loose.
- **delta-rs migration ADR** — when UC managed-Delta external write goes GA. Triggers v2+ interactive write path replacement.
- **Ingest-tier observability** — DLT pipeline health, Auto Loader lag metrics, error-file accumulation alerts, throughput dashboards. Operability-adjacent.
- **Validation rules and identifier-system normalization** — what the pre-enqueue validator checks; pluggable rule engine for customer-specific FHIR profiles.

## Open questions not closed by this ADR

- **Shared write-path library implementation.** Two implementations (TS + Python) of the same FHIR semantics. Mechanism for keeping them in lockstep beyond shared tests and shared specifications: code-review discipline, lint rules, integration suites against the same test fixtures. Operability ADR territory.
- **Bulk-path dispatch mechanism.** Databricks Jobs API kickoff is the obvious default; alternative is queue-based (a dedicated Lakeflow / DLT continuous pipeline that polls `import_jobs` for new rows). Decision belongs in operability.
- **Validation push-up.** Pre-enqueue validation needs a rule engine. v1 starts with FHIR Schema validation (required-field, type-checking); profile-aware validation (US Core, Da Vinci PAS) is v1.x. Belongs in the validation rules ADR.
- **Bulk worker autoscaling.** During year-end burst (500–2000 writes/sec), Spark cluster needs to scale; how many nodes, how fast, how do we avoid cold-start? Belongs in operability.

---

## Amendment 1 — Bronze transactional services (2026-06-19, session 014)

Per the [Bronze→Silver Governance research note](../research/2026-06-19-bronze-to-silver-governance.md) and ADR-0010 Amendment 1, the interactive and bulk write paths now write to **Bronze** rather than directly to the former Layer 1 (now Silver). Bronze owns a thin but complete set of transactional services to honor the synchronous FHIR REST contract; deep semantic processing (profile validation, MPI, merge/unmerge, reference resolution, terminology) is delegated to the customer-side Governance DLT pipeline that promotes Bronze → Silver.

### Motivation

The original §2 ("Interactive write path") assumed Conditional Create/Update could be answered against the (then) Layer 2 `identifier_index` synchronously, because the projection update landed in the same commit as the Layer 1 write. With Governance interposed between Bronze and Silver, that pattern no longer holds — `identifier_index` (now Gold per ADR-0010 Amendment 1 change 4) lags Bronze by the Governance + Silver→Gold streaming cadence. The interactive write path must still answer Conditional Create/Update synchronously per FHIR REST. Resolution: Bronze owns its own local resolver tables, fed by Bronze writes themselves and reconciled from Gold via a streaming feedback pipeline.

### Changes

**1. §2 ("Interactive write path") — write target changed to Bronze.**

The micro-batch coordinator's flush mechanism now issues `INSERT INTO bronze.<resource_type>_<fhir_version> VALUES (…), (…), …` rather than against the former `gold.<resource_type>_<fhir_version>` (now `silver.<resource_type>_<fhir_version>` per ADR-0010 Amendment 1 change 3). Silver and Gold updates flow downstream via Governance DLT pipelines (per ADR-0010 Amendment 1 §6 replacement).

**2. §2 ("Interactive write path") — Conditional Create/Update synchronous against `bronze_identifier_shortcut`.**

Replace the original §2 Conditional Update sub-bullet:

> **Conditional Create/Update flow** (synchronous at Bronze): resolver `SELECT` against `bronze_identifier_shortcut` (per ADR-0010 Amendment 1 change 2) runs before enqueue. Decision (create / update / ambiguous) is determined locally. On create: server mints UUID v7 `fhir_id` and inserts a provisional row into `bronze_identifier_shortcut` in the same Bronze commit. On update: server uses the existing `fhir_id` from the shortcut. The Bronze write proceeds without waiting for Governance.
>
> **Authoritative reconciliation.** Gold's `identifier_index` (built by Governance) is the authoritative truth. If a Bronze provisional decision disagrees with Governance's later outcome (e.g., Bronze treated as Create what Governance determines was Update), the disagreement is resolved by patient merge (per the research note §B). Surface this to operators and clients as: Conditional Update is **provisionally synchronous** at the API surface, **eventually authoritative** under the hood. Client receives 200/201 immediately; Silver-tier semantics reflect the Governance-authoritative truth after pipeline lag.

**3. §2 ("Interactive write path") — Bundle transaction processor at Bronze.**

Replace the original §2 Transaction Bundle sub-bullet:

> **Transaction Bundle:** the bundle's N entries form one dedicated Bronze commit (one bundle = one Bronze commit), bypassing the shared time-window. Bronze does the work: parse the Bundle, mint `fhir_id` for every `urn:uuid:` placeholder, rewire intra-bundle References to the minted ids, resolve each Conditional Create / Conditional Update entry against `bronze_identifier_shortcut`, commit all entries atomically.
>
> **v1 scope: single-resource-type Bundles only.** Bundles whose entries are all the same resource type get native Delta single-table atomicity. Cross-resource Bundles need multi-table atomicity, which requires either Delta's cross-table commit story (worth confirming on Databricks) or a two-phase approach with compensation on failure. Cross-resource Bundle support is deferred to a follow-up ADR (research note open question #11). v1 clients that need cross-resource Bundles either accept best-effort semantics with per-entry status, or restructure their writes as multiple single-type Bundles.

**4. New §2.1 — Bronze-resident transactional services (summary).**

Insert a new sub-section after §2:

> #### §2.1 Bronze-resident transactional services
>
> Bronze is **thin but transactional**. The Bronze tier owns these services in v1:
>
> | Service | Location | Notes |
> |---|---|---|
> | Conditional Create/Update decision | Bronze (provisional) | Synchronous against `bronze_identifier_shortcut`; Governance authoritative downstream |
> | `fhir_id` minting | Bronze | UUID v7; final — Silver does not re-mint |
> | Idempotency dedup | Bronze | Three surfaces — see §5 |
> | Bundle transaction (single-resource-type, v1) | Bronze | Atomic Delta commit; cross-resource Bundle deferred |
> | Optimistic concurrency (`If-Match`) | Bronze (best-effort) + Governance (authoritative) | Bronze checks `bronze_version_cache`; Governance catches stale slip-throughs |
>
> Governance (not Bronze) owns profile validation, terminology checks, probabilistic MPI, merge/unmerge, reference resolution, and `patient_id` stamping (per ADR-0010 Amendment 1 and the research note §"The Governance activities").
>
> See the [Bronze→Silver Governance research note](../research/2026-06-19-bronze-to-silver-governance.md) §"Bronze transactional services" for the full design including schemas, feed sources, and edge cases.

**5. New §2.2 — Gold → Bronze reconciliation feedback.**

Insert a new sub-section after §2.1:

> #### §2.2 Gold → Bronze reconciliation
>
> The Bronze-local support tables (`bronze_identifier_shortcut`, `bronze_idempotency_cache`, `bronze_version_cache`) are reconciled toward authoritative Gold/Silver state via a streaming feedback pipeline:
>
> - Gold's `identifier_index` writes → `bronze_identifier_shortcut.provisional` flips to false, or `superseded_by` is set on merge.
> - Silver writes → `bronze_version_cache` updated with latest `version_id` per `(resource_type, fhir_id)`.
> - Governance merge events → `bronze_identifier_shortcut` invalidation for retired Patient `fhir_id`s.
>
> This makes the data flow **not pure left-to-right medallion**; there is a feedback edge from Gold/Silver back into Bronze's transactional caches. The architecture diagram (`docs/diagrams/ronin-architecture-e2e.svg`) was updated in this amendment cycle to show this edge as a dotted return arrow.
>
> Reconciliation pipeline shape (streaming CDF subscription vs. periodic job) is research note open question #12 and needs a small POC.

**6. §3a ("`$import` async HTTP kickoff") — Bronze write target + idempotency cache.**

Replace step 6 of §3a:

> 6. Workers write to **Bronze** via `df.write.format("delta").mode("append")` against `bronze.<resource_type>_<fhir_version>`. Thousands of rows per commit; per-resource amortized cost matches POC batch=500 (~6.7ms / resource). Governance promotes Bronze → Silver downstream; Gold projections build from Silver. Bulk workers also write to `bronze_idempotency_cache` keyed on `(batch_id, offset)` for resume-safety on worker crashes.

The streaming projection statement at the end of §3a is updated implicitly by ADR-0010 Amendment 1 §6 replacement: Silver → Gold is streaming via DLT, not "projection updates on the bulk path."

**7. §5 ("Idempotency") — three Bronze-resident idempotency surfaces.**

Replace the existing §5 bullets with:

> Bronze owns a TTL-bounded `bronze_idempotency_cache` (per ADR-0010 Amendment 1 change 2) keyed on three surfaces:
>
> - **HTTP `Idempotency-Key` header.** Clients pass a token on writes; Bronze records the token + request fingerprint and returns the prior response on duplicates within the TTL window.
> - **Bulk worker resume.** Python/Spark workers that crash mid-batch resume safely using `(batch_id, offset)` as the idempotency key; Bronze deduplicates against already-committed offsets.
> - **FHIR `If-None-Exist` Conditional Create.** Identifier-based criteria resolve via `bronze_identifier_shortcut` (synchronous). Richer search criteria require a Gold `identifier_index` lookup (acceptable latency hit on the Conditional Create path).
>
> Per-resource Conditional Update by business identifier remains naturally idempotent under the new design (§2 + §2.1 above).
>
> The `idempotencyKey` extension on `$import` kickoff remains as before; if a kickoff arrives with a key already in `import_jobs`, the server returns the existing request's `Content-Location`.

**8. Read-your-writes contract scope narrowed.**

Append to §1 (or as a clarifying note under §2.1):

> **Read-your-writes scope.** Read-your-writes is preserved at Bronze within the micro-batch commit window. Reads against Silver and Gold (formerly Layer 2/2b/3/4) are eventually consistent, bounded by Governance pipeline + Silver→Gold streaming cadence. Practical implications:
>
> - `GET /<ResourceType>/{id}` immediately after a write may briefly return the prior version (or 404 on a brand-new create) until Gold catches up.
> - `GET /Patient/{id}/$everything`, identifier search, vread, `_history`, compartment queries all inherit eventual consistency.
> - Conditional Create/Update within a single client session is **read-its-own-writes consistent** because `bronze_identifier_shortcut` is updated synchronously with the Bronze write — a client who does `PUT /Patient?identifier=foo|bar` followed by another `PUT /Patient?identifier=foo|bar` sees consistent Create/Update resolution.
>
> This is the v1 product posture. Customers needing stronger end-to-end consistency wait for v2 architecture work.

**9. §7 ("Failure handling") — Bronze/Governance disagreement is not a failure.**

Append to §7:

> - **Bronze provisional vs Governance authoritative disagreement** (e.g., Bronze treated a Conditional Create as Create; Governance later determines the resource should have been an Update against an existing record): not a failure — handled by patient merge in Governance (per research note §B). Surfaces as a brief period during which Gold and Bronze disagree on identifier mapping; converges via the Gold → Bronze reconciliation pipeline (§2.2). No client-facing error; the Silver/Gold state becomes the authoritative truth after Governance reconciles.

### Consequences of this amendment

- Bronze writes are now the synchronous critical path; latency floor remains the session-009 measurement (~1.5s p50 per single INSERT, amortized lower under micro-batching). The earlier "synchronous projection updates" overhead is removed from this critical path.
- The Bronze-side support tables (`bronze_identifier_shortcut`, `bronze_idempotency_cache`, `bronze_version_cache`) introduce additional per-commit writes (one extra row per Create + zero or one idempotency row + zero or one version cache row). These are append-only and partitioned independently; OCC contention is per-table and per-partition.
- The Gold → Bronze reconciliation pipeline is a new operational component. Its shape and SLO are open question #12 in the research note; needs a small POC before operability sizing locks.
- Conditional Create/Update is **provisionally synchronous, eventually authoritative**. Client-facing API contract is unchanged; the under-the-hood resolution model has a brief disagreement window between Bronze and Governance. Document this in customer-facing docs to set correct expectations for clients running their own MPI cross-checks.
- Cross-resource Bundle transactions are deferred (research note open question #11). v1 Bundle support is single-resource-type. This is a documented FHIR-spec scope choice; many implementations restrict similarly.
- The architecture diagram was updated in this amendment cycle to show the Gold → Bronze feedback edge.
- ADR-0010 Amendment 1 is the structural companion to this amendment; the two should be read together.

### Status

This amendment is **Accepted** and supersedes §2 (interactive write path mechanics), §3a step 6 (bulk write target), §5 (idempotency), and the read-your-writes contract framing throughout the original ADR. §1 (two physical paths, one FHIR semantics layer), §3b/c/d/e (other bulk-entry-point posture), §4 (external-loader compatibility), §6 (authorization handoff to ADR-0006), §7 base posture, §8 (delta-rs migration target) stand as written.

> **Note (Amendment 2 below):** The "Silver" tier referenced throughout Amendment 1 was collapsed back into Gold by ADR-0010 Amendment 2. Read both amendments together — Amendment 1 mechanics (Bronze synchronous writes, identifier shortcut, idempotency, Bundle, OCC, Gold→Bronze feedback) all stand; only the destination tier label changes from "Silver" to "Gold (Layer 1 canonical resource tables)."

---

## Amendment 2 — Silver→Gold collapse (2026-06-19, session 014)

Companion to [ADR-0010 Amendment 2](0010-storage-shape.md#amendment-2--silvergold-collapse-2026-06-19-session-014). The Silver tier introduced by ADR-0010 Amendment 1 is collapsed back into Gold. The Ronin operational model becomes **Bronze (raw + transactional) → Governance (the work) → Gold (canonical + projections)** — two tiers, one transformation step.

### Motivation

The Silver tier in Amendment 1 served as a label for "governed canonical FHIR" distinct from "read-optimized projections." Reflection during the [Ronin MPI design](../research/2026-06-19-ronin-mpi-design.md) work showed the split was vocabulary more than structure: both Layer 1 (canonical) and Layer 2/2b/3/4 (projections) are read-side, downstream of one Governance transformation, and eventually consistent relative to Bronze. Treating them as a single Gold tier with internal layer numbering matches operational reality and simplifies how the write contract reads.

### Changes

**1. §2 ("Interactive write path") and §2.1 ("Bronze-resident transactional services") wording — Silver references replaced.**

Wherever Amendment 1 referenced "Silver" as the destination of Governance, the destination is now "Gold (Layer 1 canonical resource tables)" per ADR-0010 Amendment 2 change 1. The mechanics are unchanged:

- Interactive write path: Bronze synchronous within micro-batch commit window.
- Conditional Create/Update: provisional at Bronze against `bronze_identifier_shortcut`; authoritative downstream via Gold's `gold.identifier_index` (per ADR-0012 MPI design).
- Bundle transactions: Bronze-side; single-resource-type for v1.
- Idempotency cache, fhir_id minter, optimistic concurrency: Bronze.

**2. §2.2 ("Gold → Bronze reconciliation") wording unchanged.**

The reconciliation pipeline still flows from Gold's `identifier_index` (Layer 2), Layer 1 canonical writes, and merge events back into Bronze support tables. No structural change; the source side of the reconciliation feedback was already labeled Gold under Amendment 1 change 4.

**3. §3a ("`$import` async HTTP kickoff") — bulk write target wording.**

Step 6 of §3a (Amendment 1 replacement) — Bronze write target unchanged. The downstream promotion is into Gold (Layer 1 canonical resource tables) rather than into "Silver"; everything else is the same.

**4. Read-your-writes contract wording.**

The Amendment 1 framing referenced "Silver and Gold: eventually consistent." Replacement: "Gold (all layers): eventually consistent relative to Bronze, bounded by Governance pipeline + Layer 1 → Layer 2/2b/3/4 CDF cadence." Bronze read-its-own-writes within commit window still stands. Conditional Create/Update within a session is still read-its-own-writes consistent against `bronze_identifier_shortcut`.

**5. Tier-write semantics (carried from ADR-0010 Amendment 2 §6 replacement).**

For symmetry with ADR-0010:

> - **Bronze**: synchronous within the interactive write path's micro-batch commit window. Bronze-side support tables update in the same commit as the Bronze row.
> - **Gold (Layer 1 canonical resource tables)**: governed by the customer-side DLT Governance pipeline reading Bronze CDF. Streaming, eventually consistent relative to Bronze.
> - **Gold (Layer 2, 2b, 3, 4a)**: streamed from Layer 1 via Delta CDF → DLT pipelines. Eventually consistent relative to Layer 1.
> - **Gold (Layer 4b NDJSON files)**: 15-min active, daily cold refresh.
> - **Gold → Bronze feedback**: streaming reconciliation back into Bronze caches.

### Consequences of this amendment

- The write contract reads more cleanly. Two tiers; one transformation; one feedback edge.
- The ADR-0012 MPI tables (`gold.patient_link` etc.) sit naturally alongside the canonical resource tables in Gold without an intermediate tier.
- The architecture diagram drops the Silver cylinder.
- No mechanic changes — Bronze transactional services from Amendment 1 stand unchanged.
- All ADR-0011 sections outside Silver labeling are unaffected.

### Status

This amendment is **Accepted** and refines Amendment 1's tier labeling without changing its mechanics. All Amendment 1 changes (Bronze write target, synchronous Conditional resolver, Bundle processing, idempotency cache, fhir_id minter, OCC, Gold→Bronze feedback, read-your-writes scope) stand as written, with "Silver" replaced by "Gold (Layer 1 canonical resource tables)" throughout.

> **Note (Amendment 3 below):** Amendment 2's tier-collapse is walked back. Silver returns as a substantive tier with real validation, DQ, DAR fill, and MPI work happening at it. The Bronze write contract from Amendment 1 stands unchanged; the downstream promotion now goes Bronze → Silver → Gold (two stages), not Bronze → Gold (one stage).

---

## Amendment 3 — Bronze → Silver → Gold flow (2026-06-19, session 018)

Companion to [ADR-0010 Amendment 3](0010-storage-shape.md#amendment-3--silver-reinstated-as-substantive-governance-staging-tier-2026-06-19-session-018). Silver is reinstated as a substantive tier per the [validation architecture research note](../research/2026-06-19-validation-architecture.md). The Ronin operational model becomes **Bronze (raw + transactional + field SQL checks) → Silver (validation, DQ, DAR fill, MPI resolution) → Gold (canonical enterprise FHIR store + projections)** — three tiers, two governance promotions.

### Motivation

Amendment 2 collapsed Silver into Gold on the basis that Silver was vocabulary-not-substance. Session-018 validation-architecture work made the substantive distinct work at Silver concrete: assembled-resource validation (slicing, invariants), DQ + DAR fill, MPI resolution + manual review holding. Silver holds rows in flight; only blessed rows promote to Gold. This is the correct three-tier shape; we got it wrong in Amendment 2.

### Changes

**1. §2 ("Interactive write path") and §3 ("Bulk write path") write destination unchanged.**

Both paths still write to **Bronze**. Amendment 1's mechanics for the Bronze write are unchanged (idempotency, conditional resolver, fhir_id minting, Bundle processor, optimistic concurrency, Gold→Bronze reconciliation feedback). The write contract at the synchronous boundary is unchanged.

What changes is **what happens downstream of Bronze**: now Bronze → Silver → Gold (two governance promotions), not Bronze → Gold (one).

**2. Bronze field-level SQL checks added.**

After Bronze commit, per-field SQL checks run inline (generated from loaded IGs per validation-architecture note §3.2). Results captured on the Bronze row as `field_checks` struct. `silver_eligible` flag set based on field-check outcome. This is part of the synchronous Bronze pipeline; it's fast (composable SQL predicates on the dbignite body).

The per-field checks are decoupled from §2 micro-batch commit timing — they run as a streaming follow-up over Bronze CDF and update the Bronze row's `field_checks` column. The commit itself stays fast; field-check results land within the same Delta transaction window.

**3. Bronze → Silver Governance promotion (new substantive promotion).**

DLT pipeline reads Bronze CDF; per silver-eligible row runs assembled-resource validation, DQ rules + DAR fill, MPI resolution, reference resolution, residual HL7 Validator surgical use (per validation-architecture note §3). Writes to Silver with `silver_status ∈ {'pass', 'review_required', 'rejected'}`.

**4. Silver → Gold blessing promotion (new substantive promotion).**

Second DLT pipeline reads Silver CDF; promotes `silver_status='pass'` rows to `gold.<resource_type>_<fhir_version>` (Layer 1 canonical). Subsequent Gold projection pipelines (Layer 2/2b/3/4) stream from Gold Layer 1.

Rows held in Silver (`review_required` or `rejected`) never promote. Steward decisions flip `review_required` rows to `pass` or `rejected`, triggering Gold promotion or final rejection.

**5. Read-your-writes contract — two-hop eventual consistency.**

Update the read-your-writes scope:

> **Read-your-writes scope (Amendment 3 version).**
>
> - **Bronze**: read-your-writes within commit window. Bronze-local shortcut/cache reflects own writes synchronously per Amendment 1.
> - **Silver**: eventually consistent vs Bronze, bounded by Bronze→Silver Governance pipeline cadence (seconds to minutes).
> - **Gold (all layers)**: eventually consistent vs Silver, bounded by Silver→Gold blessing pipeline + downstream projection CDF cadence.
> - **`GET /<Type>/{id}`, `$everything`, identifier search, vread, `_history`, compartment queries**: all read from Gold; inherit two-hop eventual consistency.
> - **Conditional Create/Update within a session**: still read-its-own-writes consistent because the Bronze shortcut updates synchronously.

This is honest about the staged promotion. Most clients tolerate it (FHIR clients commonly retry/poll). Document the propagation lag in customer-facing API docs.

**6. §2.2 "Gold → Bronze reconciliation" updated.**

The reconciliation feedback edge stays. Source flows update: Gold's identifier_index writes (now sourced from Silver→Gold blessing CDF, not directly from Bronze→Gold) still feed Bronze shortcut updates; Silver writes feed Bronze version cache updates. The mechanism is unchanged; the source tier is one hop further downstream.

**7. §3a step 6 ("`$import` async HTTP kickoff" — bulk write target).**

Still Bronze. Workers write to `bronze.<resource_type>_<fhir_version>` (Amendment 1 §3a step 6 stands). Bronze→Silver→Gold promotions follow downstream via the same pipelines as the interactive path. Bulk-path `bronze_idempotency_cache` for worker resume per Amendment 1 unchanged.

**8. Architecture diagram update.**

Companion to ADR-0010 Amendment 3 change 5: the `docs/diagrams/ronin-architecture-e2e.svg` diagram restores the Silver cylinder between Bronze and Gold. Governance arrow goes Bronze→Silver; a new Silver→Gold blessing arrow shows the promotion. Gold→Bronze feedback stays.

### Consequences of this amendment

- The write contract on the synchronous boundary is unchanged. Bronze commit still returns 200/201; everything else moves downstream.
- Two-hop eventual consistency for read paths is the v1 product posture. Document; clients expect propagation lag.
- The validation-architecture note's hybrid SQL + HL7 Validator surgical residual is the validation substrate; Pattern A from the foundations note is now the surgical-residual approach, not the primary validator.
- The MPI resolution that Bronze→Silver Governance does is the same as ADR-0012 §1 (deterministic v1; Splink v2). Multi-match `review_required` rows stay in Silver per ADR-0012 §5 — never promote to Gold without steward approval.
- Silver storage cost is real. 30-day default retention for `silver_status='pass'` rows after Gold promotion (per ADR-0010 Amendment 3 change 1) bounds it; configurable.
- The Manual review queue (ADR-0012 §5) lives in Silver — `silver.<resource>_<ver>` rows where `silver_status='review_required'` ARE the queue. No separate queue table needed beyond `gold.patient_match_review` (which captures the review decisions; the in-flight rows themselves are Silver).

### Status

This amendment is **Accepted** and supersedes Amendment 2 changes 1, 2, 5 (Silver-to-Gold relabeling), Amendment 2 §6 (re-replaced via ADR-0010 Amendment 3 change 4), Amendment 2 read-your-writes contract (replaced above), and clarifies the Bronze→Gold one-hop flow as Bronze→Silver→Gold two-hop. All Amendment 1 mechanics (Bronze transactional services) stand unchanged.
