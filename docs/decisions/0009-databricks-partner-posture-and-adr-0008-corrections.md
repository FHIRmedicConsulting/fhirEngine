# ADR-0009: Databricks Partner Ecosystem Posture, and ADR-0008 Corrections

- Status: **Accepted**
- Date: 2026-06-17
- Decider(s): Chad
- Session: 005
- Amends: [ADR-0008](0008-updated-vision-and-scope.md) (does not supersede)
- Related: [ADR-0001 (Superseded)](0001-vision-and-scope.md), [docs/research/2026-06-17-lakehouse-storage-and-crud.md](../research/2026-06-17-lakehouse-storage-and-crud.md)

## Context

ADR-0008 was Accepted earlier this same day (2026-06-17). Session 005 began with a dbignite deep read, which immediately surfaced two facts ADR-0008 did not account for:

1. **dbignite is not Apache 2.0.** It carries the **Databricks License**, which restricts use to "in connection with your use of the Databricks Services pursuant to the Agreement." ADR-0008 D2 Consequences claimed "dbignite is Apache 2.0 PySpark, runs anywhere Spark+Delta runs" — that claim is factually wrong and was asserted without verification.
2. The Databricks-license restriction is **not a problem for Ronin** because Chad's intent is to sell Ronin into the **Databricks Partner ecosystem**. Ronin's deployments are Databricks Services customers; the Databricks License "Scope of Use" clause is satisfied by definition. This reframes "multi-cloud OSS" cleanly: multi-cloud means Databricks-on-AWS / Databricks-on-Azure / Databricks-on-GCP — not "runs on any OSS Spark+Delta runtime."

Additionally, Chad clarified that the analytics tier is a v3/v4 concern requiring deep use case review, not v1 work. This narrows the polyglot architecture in v1 and reframes the build-from-scratch rationale.

This ADR amends ADR-0008's specific decisions to reflect these facts. ADR-0008 stays Accepted; this is a surgical amendment, not a supersession.

## Decision

### Amendment 1 — ADR-0008 D1 multi-cloud framing

ADR-0008 D1 reads: "Ronin is an open-source, multi-cloud, FHIR server backed by a lakehouse Gold Data Model."

Amend to make the multi-cloud meaning explicit:

> "Ronin is an open-source, **Databricks-targeted** FHIR server backed by a lakehouse Gold Data Model. **Multi-cloud reach is via Databricks Services on AWS, Azure, and GCP** — not deployment on arbitrary OSS Spark+Delta runtimes. Ronin is built for the Databricks Partner ecosystem; Databricks Services is an assumed substrate."

The "open-source" property is preserved for **Ronin's own code** (Apache 2.0). Inbound dependencies on Databricks-licensed components (dbignite, Unity Catalog managed offerings, DLT, etc.) are acceptable because Ronin's customers will have a Databricks Services Agreement.

### Amendment 2 — ADR-0008 D2 license correction

ADR-0008 D2 Consequences contained the assertion: "dbignite is Apache 2.0 PySpark, runs anywhere Spark+Delta runs."

This is **factually incorrect**. Correction:

> "dbignite carries the **Databricks License** (LICENSE file in `databricks-industry-solutions/dbignite`, dated 2022). Its Scope of Use clause restricts use to 'in connection with your use of the Databricks Services pursuant to the Agreement.' Consumption is legitimate within Ronin's deployment model because Ronin targets Databricks Services customers. The underlying schema knowledge dbignite represents derives from HL7 FHIR StructureDefinitions, which are **CC0 (public domain)**; the dbignite library's transcription and packaging of that knowledge is what carries the Databricks License."

This affects how Ronin can consume dbignite:

- **Within Ronin's Databricks-targeted deployments**: dbignite is fair game as a library, a schema reference, or both. We may consume it directly in the Python tier, or use it as a shape specification for Ronin's own implementation, or both.
- **For Ronin's own code distribution**: Ronin's repository and published artifacts remain Apache 2.0 (per ADR-0008 D4). dbignite is an inbound runtime dependency, not redistributed code.
- **If Ronin's go-to-market ever expands beyond Databricks Services**: this amendment would need revisiting, and Ronin would need a non-dbignite path for the body schema (CC0 HL7 sources allow building one).

### Amendment 3 — Databricks Partner ecosystem as explicit GTM posture

Add as a new posture statement (carries D-number 10 for traceability):

> "**Ronin's go-to-market is the Databricks Partner ecosystem.** Target customers are payers, providers, health systems, research orgs, and health AI teams who have made the Databricks bet and want a FHIR server that's lakehouse-native operational without a Postgres tier. The competitive wedge vs. Aidbox-on-Lakebase is *Delta-native operational* (Lakebase remains managed Postgres with Delta sync) and *open-source* (Aidbox remains commercial). The competitive wedge vs. building from HAPI/Aidbox/Smile CDR on Databricks is *no Postgres in the critical path*."

### Amendment 4 — ADR-0008 D6 polyglot v1 scope clarification

> **Wording sharpened 2026-06-17 in session 007** — Bulk Import ingestion is NOT a Python responsibility; it goes through the TS write path. See revision note in [docs/research/2026-06-17-polyglot-write-contract.md](../research/2026-06-17-polyglot-write-contract.md). This is errata to the original Amendment 4 wording; the ADR's Accepted status is preserved.
>
> **Further sharpened 2026-06-18 in session 008** — the session 007 errata cited the Microsoft FHIR-Bulk Loader as "the architectural model" for Bulk Import. That overstated the external-loader pattern. Reading Microsoft's own FHIR Server docs showed Microsoft's native `$import` is server-side ingestion (the HAPI / Aidbox pattern: server reads NDJSON URLs from the manifest in-process and applies entries internally). **Ronin's default is server-side `$import` ingestion in the TS server process.** External loaders (Microsoft FHIR-Bulk Loader and equivalents) remain compatible with Ronin's REST surface but are not Ronin-shipped and not the assumed pattern. The Python-tier scope corrected by Amendment 4 stands as written below — Bulk Import ingestion is not in the v1 Python footprint either way. What changed: the bulk path's TS-side default is the server's own `$import` handler, not a customer-run external loader. ADR's Accepted status preserved.
>
> **Third revision 2026-06-19 in session 010** — sessions 007 and 008 framed Bulk Import ingestion as TS-server-in-process. That was right for sub-10M-member customer profiles but wrong for Ronin's stated target ("big and fast for ingestion," 10M-member large payer scale with room to grow to healthcare provider workloads). Per the [sizing model](../research/2026-06-18-payer-volume-sizing.md) and the [positioning review](../research/2026-06-19-positioning-review-big-and-fast.md): internal claims/eligibility/clinical ingest alone runs 400–600M resource writes/year at 10M-member scale, with 500–2000 writes/sec burst windows. That volume is fundamentally a Spark / distributed-batch workload, not a TS-process workload. **Ronin's Python/Spark tier owns all bulk ingest pipelines** — `$import` async ingestion (workers triggered by HTTP kickoff at the TS server), SFTP file drop (workers triggered by cloud-storage file events / Auto Loader), Bulk Export prep, and projection materialization. The TS server's `$import` handler is reduced to: validate manifest, write to `import_jobs`, dispatch to Python/Spark workers, expose status URL. This mirrors HAPI's Batch 2 framework architecturally: REST server orchestrates, distributed batch jobs run the actual ingest. Delta Sharing inbound is **deferred to post-v1** per Chad ("nice to have, not needed for v1"). The v1 polyglot scope wording below has been updated. ADR remains Accepted; this is errata to a wording detail, not a new decision.

ADR-0008 D6 framed the polyglot architecture as "TypeScript/Node FHIR REST server + Python/PySpark analytics tier." Clarification: the **analytics tier is a v3/v4 concern**, requiring in-depth use case review before scoping. v1 polyglot is narrower:

> "v1 polyglot: **TypeScript/Node FHIR REST server** + **a Python/PySpark tier that owns the high-volume ingest and projection pipelines**. The TS server handles the interactive FHIR REST surface (the four CMS APIs' HTTP handlers, Conditional Update resolver via micro-batch coordinator, SMART auth, `$import` kickoff orchestration, status URL handlers, audit log). The Python/Spark tier owns:
>
> - **Projection materialization** — Delta CDF → Spark Streaming / DLT pipelines that maintain `identifier_index`, `references_index`, current-version projection, and the materialized Patient compartment.
> - **Bulk Import ingestion at volume** — workers triggered by the TS server's `$import` kickoff (HTTP) and by cloud-storage file events / Auto Loader (SFTP file drop). Workers read NDJSON / Bundle / file payloads, transform, validate, and write to Delta via Spark DataFrame batch writers.
> - **Bulk Export prep** — NDJSON staging on UC volumes, manifest assembly, `$export` worker dispatch.
>
> The TS server's `$import` handler is the orchestrator and status surface; the actual NDJSON reading and Delta writes at volume happen in the Python/Spark tier (architecturally similar to HAPI's Batch 2 framework: REST orchestrates, distributed batch runs the ingest). External-loader patterns (Microsoft [FHIR-Bulk Loader](https://github.com/microsoft/fhir-loader) and equivalents) remain compatible with Ronin's `$import` REST surface but are not Ronin-shipped — customers run them if they want the per-resource-POST pattern.
>
> **Delta Sharing inbound** (consuming partner Delta shares as an ingest mechanism) and **Delta Sharing outbound** (publishing Ronin projections as shares to downstream consumers) are **deferred to post-v1** as "nice to have, not needed for v1" — high-value for sophisticated Databricks-native partners, but not on the v1 critical path.
>
> The full Python/PySpark analytics tier — interactive analytics, SoF v2 production execution, terminology batch services, advanced bulk submit, ML feature engineering — is a v3/v4 primary need not yet scoped, and explicitly out of v1. The line between the v1 ingest/projection Python footprint and the v3/v4 analytics footprint is increasingly thin (both consume dbignite, both run on Spark/DLT, both write to UC); they share the runtime but differ in workload posture (v1 = ingest + projection maintenance; v3/v4 = interactive analytics + AI/ML)."

The architecture **preserves headroom** for the v3/v4 analytics tier (dbignite-shaped tables are the durable bridge), but v1 ships without it.

### Amendment 5 — ADR-0008 D7 build-from-scratch rationale

ADR-0008 D7 read: "Build foundation services from scratch, optimized for the polyglot lakehouse... The reason is that existing implementations (atomic-ehr, HAPI, Pathling) carry Postgres-era or analytics-only assumptions that are wrong for Ronin's operational-lakehouse target."

This rationale stays intact for the **TypeScript REST server's foundation services** (FHIRPath engine, validation, codegen, identifier-aware match resolver, bulk primitives, audit log, terminology client). Those are still built from scratch.

For the **Python tier in v1**, the build-from-scratch stance softens: dbignite is consumable directly on Databricks deployments, so where its shape and library serve Ronin's bulk-operations and projection-materialization needs, **we consume it rather than rebuild it**. Build-from-scratch was driven by (a) avoiding wrong-shaped assumptions and (b) avoiding license entanglement. (b) is no longer a Databricks-ecosystem concern; (a) is empirically tested per component.

For the **v3/v4 analytics tier** (when scoped), the build vs. adopt question reopens with full use case review. Default expectation: adopt where dbignite (and other Databricks Labs offerings) fit; build where they don't.

### Amendment 6 — Queued ADR simplification

Several queued ADRs in ADR-0008 collapse or drop priority under the Databricks-targeted posture:

- **ADR-0003 (catalog choice)** — substantially collapses. **Unity Catalog (Databricks-managed) becomes the default** for v1; the comparative analysis of "Unity Catalog OSS vs. Polaris vs. Hive vs. Nessie" is no longer load-bearing. ADR-0003 may still be written as a 1-page record but its content shifts to "we use Unity Catalog because we're Databricks-targeted."
- **ADR-0007 (Iceberg compatibility)** — drops in priority. **Databricks supports Iceberg via Uniform**, which handles the downstream-consumer-wants-Iceberg case without dual-writing at our operational tier. Iceberg compatibility becomes a property of our output to consumers, not a property of our storage architecture.
- **Replacement runtime/language ADR** — narrows. TypeScript/Node for the REST server stays; Python for v1 bulk operations stays; Python/PySpark analytics tier discovery moves to v3/v4. The portable-core-in-Rust-or-Go vs. dual-implementations question still stands for the TS server's foundation services.

## Consequences

- **"Open-source" claims are about Ronin's own code**, not the full stack. Apache 2.0 for Ronin's repos and published artifacts; Databricks-licensed (or other) for inbound runtime dependencies. Marketing should read "Apache 2.0 open-source FHIR server for the Databricks platform," not "fully OSS-stack FHIR server."
- **Customer prerequisite is a Databricks Services Agreement.** Ronin does not deploy on bare-metal Spark, OSS Kubernetes Spark, AWS EMR, Azure Synapse Spark, or GCP Dataproc. Ronin deploys on Databricks workspaces (on AWS, Azure, or GCP) and assumes Unity Catalog, Delta, Databricks SQL, and other native services.
- **Analytics tier is out of v1.** v1 ships the operational REST server + lakehouse-native CRUD + Bulk + SMART + narrow MDM. The dbignite-shaped storage preserves the analytics future, but no analytics-specific code ships in v1.
- **dbignite is consumable directly** in the v1 Python footprint (bulk operations) and in the future v3/v4 analytics tier. The schema knowledge (CC0 HL7 sources) is available for re-derivation if Ronin's market ever expands beyond Databricks, but that is not a v1 concern.
- **The Aidbox-on-Lakebase comparison sharpens.** Both are Databricks-deployable FHIR offerings. Differentiators: Ronin is OSS (Apache 2.0 for our code) vs. Aidbox commercial; Ronin is Delta-native operational vs. Aidbox-on-Lakebase Postgres operational; Ronin is multi-version-from-day-one vs. Aidbox's R4-leading multi-version posture (verifiable separately if it becomes a marketing question).
- **18–24 month foundation horizon stays.** Removing the analytics tier from v1 shortens the v1 critical path, but the foundation services for the TS server (FHIRPath, validation, codegen, resolver) remain the long lift.
- **Queue cleanup.** ADR-0003 collapses; ADR-0007 drops priority; replacement runtime ADR narrows. Updated in INDEX.

## What this ADR does NOT decide

- The specific Databricks-native services Ronin depends on beyond Delta + Unity Catalog (Databricks SQL Connector, DLT, MLflow, Lakeflow, Mosaic AI, etc.). Each is a future decision when its use case lands.
- Whether Ronin distributes via Databricks Marketplace, Databricks Apps, a partner integration, or some combination. GTM mechanics are out of scope for an architecture record.
- Whether dbignite-as-Python-library is consumed directly or via a thin Ronin wrapper. Defer to the polyglot write contract ADR.
- The v3/v4 analytics tier scope. Explicitly deferred pending use case review.
- Whether Ronin's published artifacts can include dbignite-derived schema files (redistribution under the Databricks License is permitted with attribution; review when the question becomes concrete).

## Alternatives considered

- **Stay with the "multi-cloud OSS-Spark-anywhere" framing from ADR-0008.** Rejected: it was based on a factual error about dbignite's license, and it doesn't match Chad's stated go-to-market (Databricks Partner ecosystem).
- **Treat the dbignite license as a forcing function to reimplement from CC0 HL7 sources.** Rejected for v1 because Ronin's customers will have Databricks Agreements; the license restriction is satisfied. Retained as an option for a future expansion beyond Databricks.
- **Keep the full polyglot architecture (server + analytics tier) in v1 scope.** Rejected per Chad's clarification — analytics is v3/v4 with primary-need-not-yet-scoped framing.

## Relationship to ADR-0008

ADR-0008 stays **Accepted**, **amended by ADR-0009**. The decisions ADR-0008 contains remain operative; ADR-0009 supplies surgical corrections and clarifications to specific items (D1, D2, D6, D7) and adds a new posture statement (Databricks Partner ecosystem GTM). Future readers should read both together as the current operative direction.

A cross-reference header is added to ADR-0008 pointing at this ADR.
