# ADR-0001: Vision, Scope, and Project Posture

- Status: **Superseded by [ADR-0008](0008-updated-vision-and-scope.md)** (was Accepted 2026-05-29)
- Date: 2026-05-29 (originally Accepted); 2026-06-17 (superseded)
- Decider(s): Chad
- Session: 001 (original), 004 (superseded)

> **Note (2026-06-17):** This ADR has been superseded by ADR-0008. It remains in the record as the original vision/scope anchor — the work that produced it is unaltered. ADR-0008 restates the decisions in refined form after sessions 002–004. For current Ronin direction, read ADR-0008. For historical context on how we got here, read this.

## Context

Project Ronin starts as an attempt to fork the open-source components of Health Samurai's ecosystem and re-platform them onto an open lakehouse (Delta / Iceberg) using the Databricks dbignite schema as the FHIR Gold Data Model. The first task is to lock in vision and posture before any code or detailed architecture work begins, so subsequent ADRs have a stable anchor.

The user has explicitly said: "If we take the time to align the vision, do the research, then come up with a workable plan. This is a big beefy project that will take awhile."

## Decision

1. **Ronin is an open-source, multi-cloud, FHIR R4/R5 server backed by a lakehouse Gold Data Model.** It is not a fork of any single Health Samurai product; it is a re-platforming of the OSS-licensed components Health Samurai (and the related `atomic-ehr` org) publish, plus net-new server, storage, and API layers.
2. **The dbignite schema (Databricks Industry Solutions) is the canonical Gold Data Model.** ViewDefinitions and FHIR API projections both read from those tables; we do not maintain a second physical model.
3. **Storage is lakehouse-native, not Postgres.** Delta is the primary table format; Iceberg compatibility is a strong second goal.
4. **License: Apache 2.0** for everything Ronin writes, unless an inbound dependency forces a more restrictive license (in which case we isolate that dep behind a service boundary).
5. **Scope of v1 ships only:** FHIR REST read/search/transaction, Bulk `$export` and `$import`, SMART on FHIR auth, SQL-on-FHIR v2 ViewDefinition runner, US Core conformance for the priority resource set.
6. **Out of scope for v1:** terminology server (integrate, do not build), MDM/MPI, prior-auth-specific IGs (Da Vinci PAS, CRD, DTR), C-CDA conversion, HL7v2 conversion. Each of these is a candidate for v2 once the storage foundation is solid.

## Consequences

- Every storage decision must hold up under two workloads: low-latency single-resource reads (FHIR API) AND high-throughput scans (analytics, bulk export). That tension is the central engineering problem and drives most subsequent ADRs.
- We will need to track Aidbox-on-Lakebase and Pathling carefully — both are credible competitors/reference points.
- The dbignite schema as currently published is analytics-shaped (resource-grouped, flattened, no per-resource history table). v1 will need to extend it for FHIR history/versioning semantics. That extension belongs in a future ADR.
- We accept that the first 6–12 months produce no shippable product — only foundations and proofs.

## Alternatives considered

- **Fork Aidbox directly.** Rejected: Aidbox is not OSS; its commercial license blocks the fork.
- **Fork Pathling and add a write path.** Live option for a future ADR. Pathling is the closest existing OSS analog (Apache 2.0, Spark-based, SQL-on-FHIR implementer). Tabling now so we can decide after deeper code-level study.
- **Build on top of Fhirbase.** Rejected as the foundation: Fhirbase is frozen, Postgres-bound, and its model is row-per-resource JSONB, not lakehouse-shaped.
- **Use Lakebase as the operational tier.** Rejected: Lakebase locks us to Databricks and contradicts the multi-cloud OSS thesis.

## Follow-up ADRs queued

- ADR-0002: Choose the runtime language/stack for the FHIR API server.
- ADR-0003: Catalog choice (Unity Catalog OSS vs. Apache Polaris vs. Hive Metastore vs. Nessie).
- ADR-0004: How dbignite extends to FHIR history/versioning.
- ADR-0005: Search index strategy on Delta (Z-order, liquid clustering, secondary index).
