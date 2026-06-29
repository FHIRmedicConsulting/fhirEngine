# ADR-0008: Updated Vision and Scope (supersedes ADR-0001)

- Status: **Accepted, amended by [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md)**
- Date: 2026-06-17
- Decider(s): Chad
- Session: 004 (Accepted), 005 (amended by ADR-0009)
- Supersedes: [ADR-0001](0001-vision-and-scope.md)
- Amended by: [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md) — Databricks Partner ecosystem posture + corrections to D1 (multi-cloud framing), D2 (dbignite license), D6 (polyglot v1 scope), D7 (build-from-scratch rationale); queue simplification for ADR-0003 and ADR-0007.
- Related: [docs/research/2026-06-17-pathling-deep-read.md](../research/2026-06-17-pathling-deep-read.md), [docs/research/2026-06-17-lakehouse-storage-and-crud.md](../research/2026-06-17-lakehouse-storage-and-crud.md), [docs/reference/pathling-architecture.md](../reference/pathling-architecture.md), [ADR-0002 (Rejected)](0002-runtime-language-and-stack.md)

> **Note (2026-06-17):** ADR-0009 amends specific items in this ADR. Read both together for the current operative direction. The decisions below remain operative as written, with the corrections specified in ADR-0009.

## Context

ADR-0001 set the original vision and scope. Three sessions of research and review have refined the foundation materially:

- The Pathling deep read (session 002) confirmed Pathling is R4-hardcoded across encoders, search, conversion, and terminology — disqualifying it as Ronin's primary engine given a multi-version requirement.
- The ADR-0001 review (session 003) surfaced regulatory clarification (CMS-0057-F "minimum standards" language allows higher FHIR versions above the R4 floor), confirmed R6 is anticipated fast enough to require multi-version architecture from day one, and committed to a polyglot architecture (TypeScript server + Python analytics) as critical for Payer-to-Payer and bulk data workloads.
- The lakehouse storage and CRUD research (session 003) surfaced the load-bearing distinction between FHIR `id` (server handle) and business identifier (matching key), pulling the storage shape toward append-only with a denormalized identifier projection — and bringing MDM/MPI into v1 with a narrow operational semantic.
- The storage research note flagged a tension on the canonical schema anchor. **Resolved this session: dbignite is the canonical body schema (validating ADR-0001 D2 as originally written).** Parquet-on-FHIR remains useful field reconnaissance — specifically the reference-projection trick for free JOINs may be adopted as a dbignite extension — but is not the canonical body shape.

This ADR ratifies that refined foundation in one place. ADR-0001 is preserved as historical context with a Superseded-by pointer.

## Decision

Decisions are numbered to mirror ADR-0001 where the topic carries over, with new decisions appended. Decisions retained from ADR-0001 without material change are repeated for completeness so this document stands on its own.

1. **Ronin is an open-source, multi-cloud, FHIR server backed by a lakehouse Gold Data Model.** It is **not** a fork or re-platform of Health Samurai, atomic-ehr, or Pathling code. Ronin **builds atomic-ehr-equivalent foundation services from scratch, optimized for the polyglot lakehouse**. Adoption of *spec artifacts* (FHIR Schema JSON format, ViewDefinition JSON, US Core profiles) is fine and expected; adoption of *implementations* is not.

2. **The dbignite schema (Databricks Industry Solutions, Apache 2.0) is the canonical Gold Data Model body schema.** ViewDefinitions and FHIR API projections both read from dbignite-shaped tables. The **single source of truth** is one set of resource tables; all other physical tables in Ronin (identifier projection, current-version projection, search indices, materialized views) are **derived projections** of those tables, materialized for operational performance. This re-wording (from the original "we do not maintain a second physical model") preserves the original intent — no Postgres operational tier with Delta analytical mirror — while accommodating the layered projection-from-source pattern that operational reads require. Parquet-on-FHIR (OHS Foundation) is a useful reference for body schema conventions and the reference-projection trick (resource-type-specific id columns inside Reference groups), and may be adopted as targeted extensions to the dbignite shape, but dbignite is canonical.

3. **Storage is lakehouse-native; Delta is the v1 primary table format; Iceberg compatibility remains a strong second goal.** No Postgres anywhere in Ronin's critical path. Aidbox-on-Lakebase (Postgres mirror with Delta sync via Moonlink) is explicitly rejected as a reference architecture for Ronin.

4. **License: Apache 2.0** for everything Ronin writes, unless an inbound dependency forces a more restrictive license (in which case we isolate that dep behind a service boundary).

5. **FHIR version posture: R4 as the wire floor, R4B and R5 served concurrently at distinct API paths, R6-ready in architecture.** CMS-0057-F's "minimum standards" language permits higher FHIR versions above the R4 floor; higher versions are served at separate paths (e.g., `/fhir/R4/Patient/{id}` and `/fhir/R5/Patient/{id}`) with internal storage shared where the schema overlaps cleanly and split where it doesn't. R6 must be absorbable into the architecture without engine swap; v1 does not need to ship R6 endpoints but the storage and routing must accommodate them when they land.

6. **Polyglot architecture.** TypeScript/Node FHIR REST server + Python/PySpark analytics tier. The shared contract between runtimes is **FHIR-standard artifacts** (dbignite-shaped Delta tables, NDJSON for bulk, ViewDefinitions if/when they become a published contract) — not internal interfaces, not RPC schemas, not shared codebases. Each runtime is best-in-class at its job. This is critical for Payer-to-Payer and bulk data workloads.

7. **Build foundation services from scratch, optimized for the polyglot lakehouse.** The "atomic-ehr-equivalent" surface — FHIR Schema implementation, FHIRPath engine, codegen, validation engine, identifier-projection-aware match resolver, bulk primitives, audit/event log, terminology client + cache — is built fresh, not adopted wholesale. The reason is that existing implementations (atomic-ehr, HAPI, Pathling) carry Postgres-era or analytics-only assumptions that are wrong for Ronin's operational-lakehouse target. Rapid iteration is a design constraint; spec lockstep with upstream is preferred over implementation reuse.

8. **v1 scope ships:**
    - FHIR REST: full CRUD (Create, Read, Update, Delete) **including Conditional Update** keyed on business identifier as the primary write path.
    - vread and `_history` for individual resources (free from the append-only storage shape).
    - Transaction bundles (batch + transaction).
    - PATCH (basic — FHIRPath Patch deferred to v2).
    - Bulk Data Access: `$export` (system, patient, group) and `$import` (NDJSON, Parquet, Delta sources).
    - SMART on FHIR auth (OAuth2 resource server, well-known SMART configuration, external IdP).
    - US Core conformance for the priority resource set. (US Core version pin and resource set deferred to a v1-conformance-targets ADR.)
    - **MDM/MPI in v1, narrowly scoped.** Operational semantic: exact business-identifier match (system + value), latest write wins on the resource as a whole. Out of scope within MDM-in-v1: probabilistic/fuzzy matching, manual review queues, linkage records connecting unrelated identifiers, survivorship rules, element-level period-end-stamping on overwrites. Storage substrate is built to support those v2/v3 extensions without schema migration.

9. **Out of scope for v1:** terminology server (integrate, do not build); prior-auth-specific IGs (Da Vinci PAS, CRD, DTR); C-CDA conversion; HL7v2 conversion; SQL-on-FHIR v2 ViewDefinition runner (deferred — native lakehouse primitives subsume the execution use case; SoF v2 may earn keep later as a contract format only). Each remains a candidate for v2 once the foundation is solid.

## Consequences

- Pathling is not a v1 dependency, in any form. The Pathling reference and research notes remain valid as field reconnaissance but the project does not consume Pathling code or artifacts.
- The runtime/language ADR (ADR-0002, Rejected) needs a replacement once the storage shape and write contract are settled. Expected shape: TypeScript/Node for the REST server (atomic-ehr-aligned function, not atomic-ehr code); Python/PySpark for the analytics tier; algorithmic core (FHIRPath, ViewDefinition compiler, validator) implemented for cross-language consumption (Rust/Go with bindings vs. dual TS+Python in spec lockstep — open).
- The storage shape sketched in the lakehouse storage research note (append-only resource tables per `(resource_type, fhir_version)`, denormalized identifier projection sidecar, current-version projection) is **directionally accepted** by this ADR but **not formally ratified** here. A storage-shape ADR will follow after the research note's open questions (polyglot write contract, identifier-system normalization, soft-delete semantics, read latency budget) are resolved.
- The dbignite canonical confirmation means the resource body schema is dbignite-shaped, not Parquet-on-FHIR-shaped. The research note's proposal of "Parquet-on-FHIR body schema" needs to be updated to reflect dbignite as canonical, with Parquet-on-FHIR retained as a source of targeted extensions (reference-projection trick).
- Multi-version FHIR at the wire layer means routing, serialization, and validation are version-aware from day one. Internal storage is shared where versions are compatible; per-version tables where they aren't. URL path versioning (`/fhir/R4/`, `/fhir/R5/`) is the routing convention.
- MDM-in-v1 changes the boundary between "FHIR server" and "identity infrastructure." Ronin owns the substrate (identifier projection, conditional-update resolver) and the v1 semantic (exact-match, latest-wins). External MDM tools — or Ronin's own v2/v3 extensions — plug into the resolver.
- The 6–12 month "no shippable product" horizon from ADR-0001 expands to **18–24 months of foundations before v1 ships**, per session 003 discussion. POC milestones will surface earlier.
- Multi-cloud OSS posture is reaffirmed. dbignite is Apache 2.0 Python on PySpark+Delta; it runs anywhere Spark+Delta runs. Databricks is the most-tested execution target; AWS Glue, OSS Spark+Polaris, Azure Synapse, and GCP Dataproc are all viable targets and need verification but no fundamental incompatibility.

## What this ADR does NOT decide

- **Runtime/language replacement for ADR-0002.** Open. Awaits storage-shape ADR.
- **Storage shape formal ratification.** Directionally accepted; formal ADR follows the research note's open-questions resolution.
- **Polyglot write contract.** Open; largest unresolved engineering question.
- **Catalog choice** (Unity Catalog OSS / Polaris / Hive / Nessie). ADR-0003 still queued.
- **Iceberg compatibility shape** (dual-write vs. translate). ADR-0007 still queued.
- **US Core version pin** and priority resource set. Separate v1-conformance-targets ADR queued.
- **Search execution model** beyond identifier-based lookup. ADR-0005 still queued.
- **SMART on FHIR specifics** (IdP choice, scope grammar). ADR-0006 still queued.
- **ID generation policy** (UUID v4 vs. v7 vs. ULID). Deferred to storage-shape ADR.
- **Foundation services boundary** — single portable core (Rust/Go) vs. dual TS+Python in spec lockstep. Deferred.

## Alternatives considered

The major alternatives are captured in the rejected ADR-0002 and the research notes. Summary:

- **Fork or consume Pathling as base** — rejected (ADR-0002): R4 hardcoding violates the multi-version requirement.
- **Postgres operational + Delta analytical mirror (Aidbox-on-Lakebase shape)** — rejected: Postgres in the critical path negates Ronin's wedge.
- **Single-runtime (TypeScript only, Python only, or JVM only)** — rejected in favor of polyglot for Payer-to-Payer + bulk workloads.
- **Consume atomic-ehr or HAPI wholesale** — rejected in favor of building foundation services from scratch optimized for the polyglot lakehouse.
- **R4-only v1 with R5/R6 deferred** — rejected: R6 timeline is too aggressive to absorb later; multi-version from day one is structural.
- **Parquet-on-FHIR as canonical body schema** — rejected this session in favor of dbignite, with Parquet-on-FHIR conventions retained as targeted extensions.
- **SoF v2 ViewDefinition runner in v1** — deferred: native lakehouse primitives subsume the execution use case; SoF v2 may earn keep later as a contract format.

## Follow-up ADRs queued

- Replacement runtime/language ADR (post-storage-shape).
- Storage shape ADR (post research-note resolution).
- Polyglot write contract ADR.
- v1 conformance targets ADR (US Core version, priority resource set, Inferno test scope).
- ADR-0003 catalog choice.
- ADR-0005 search execution model.
- ADR-0006 SMART on FHIR specifics.
- ADR-0007 Iceberg compatibility shape.
- Foundation services boundary ADR (portable core vs. dual implementations).

## Relationship to ADR-0001

ADR-0001 is **superseded** by this ADR. It remains in the record as the original vision/scope anchor — the work that produced it (May 2026 research survey, Health Samurai inventory, dbignite schema reference, SoF v2 study, competitive landscape) is unaltered and remains valid. The decisions are restated and refined here in light of subsequent research.

Specifically, of ADR-0001's six decisions:
- D1: refined (build from scratch; multi-version; polyglot added).
- D2: retained as canonical anchor; rewording for layered projection from source-of-truth (cosmetic, not substantive).
- D3: retained (Delta primary, Iceberg strong second goal); no-Postgres made explicit.
- D4: retained unchanged.
- D5: refined (CRUD/Conditional Update added; MDM-in-v1 added; SoF v2 runner removed; US Core scoping deferred).
- D6: refined (MDM/MPI removed from out-of-scope; rest retained).
