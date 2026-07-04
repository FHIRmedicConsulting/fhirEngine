# ADR Index

Architecture Decision Records, chronological. Numbers never reused. Status: Proposed / Accepted / Superseded / Rejected / Deprecated.

| # | Title | Status | Date |
|---|---|---|---|
| 0001 | [Vision, Scope, and Project Posture](0001-vision-and-scope.md) | Superseded by 0008 | 2026-05-29 (2026-06-17 superseded) |
| 0002 | [Runtime Language and Stack](0002-runtime-language-and-stack.md) | Rejected | 2026-06-17 |
| 0005 | [Search Execution Model — Hybrid Patient-Compartment + Layer 4c Search-Index + Direct Projection Scan, Three-Tier Parameter Coverage, Post-Filter `Bundle.total`](0005-search-execution-model.md) | Accepted | 2026-06-20 |
| 0006 | [SMART on FHIR + UDAP Security — v1 Ships Both, Hybrid UDAP Gateway, Customer-Supplied OIDC IdP, Five-Point Scope+Consent Enforcement](0006-smart-on-fhir-and-udap-security.md) | Accepted | 2026-06-20 |
| 0008 | [Updated Vision and Scope](0008-updated-vision-and-scope.md) | Accepted, amended by 0009 | 2026-06-17 |
| 0009 | [Databricks Partner Ecosystem Posture and ADR-0008 Corrections](0009-databricks-partner-posture-and-adr-0008-corrections.md) | Accepted (Amendment 4 third-revised 2026-06-19) | 2026-06-17 |
| 0010 | [Storage Shape — Layered Append-Only Design with Materialized Patient Compartment](0010-storage-shape.md) | Accepted (Amendments 1+2+3 2026-06-19 — Bronze tier + Silver→Gold collapse + Silver reinstated) | 2026-06-19 |
| 0011 | [Write Contract — Interactive (TS + Micro-Batch) and Bulk (Python/Spark) Physical Paths](0011-write-contract.md) | Accepted (Amendments 1+2+3 2026-06-19 — Bronze transactional + collapse + Bronze→Silver→Gold flow) | 2026-06-19 |
| 0012 | [Master Patient Index — Deterministic v1, Splink v2 with Guardrails, PPRL v1.x, HITL Review Queue](0012-master-patient-index.md) | Accepted (Amendment 1: `$member-match` 422 semantics + ephemeral-input anti-pattern + adapter-stamped meta.profile, 2026-06-21) | 2026-06-19 |
| 0013 | [Deployment Posture — Databricks-Native, Bundle-First, Apps-Hosted](0013-deployment-posture.md) | Accepted | 2026-06-19 |
| 0014 | [Conformance Targets and IG Matrix — Floor + CI/CD Upgrade Rails](0014-conformance-targets-and-ig-matrix.md) | Accepted (Amendment 1 2026-06-20 — terminology anchor stack corrected) | 2026-06-19 |
| 0015 | [Validation Architecture — Hybrid SQL + Silver Assembled + HL7 Validator Surgical Residual](0015-validation-architecture.md) | Accepted (Amendment 2 2026-06-20 — Security Labeling Service added) | 2026-06-19 |
| 0016 | [Audit and Access Transparency — AuditEvent + Application Log + SMART OAuth Events + Lakehouse-Native Federated-Store Resolution](0016-audit-and-access-transparency.md) | Accepted | 2026-06-19 |
| 0017 | [Terminology Service — Delta-Backed CodeSystems, Pure-Local Resolution, Operator-Pulled Refresh, THO + Licensed-Source Layering](0017-terminology-service.md) | Accepted | 2026-06-20 |
| 0018 | [Patient Portal + Consent + Read-Time Filter — Separate Ronin App, FHIR Consent Storage, Multi-Level Security Gate, HCS Label-Aware Enforcement](0018-patient-portal-consent-and-read-time-filter.md) | Accepted | 2026-06-20 |
| 0019 | [Storage & Pipeline Operations — Schema Evolution, OPTIMIZE/VACUUM/ZORDER, Three-DLT-Pipeline Architecture, Spark-Library Validator, MPI Cadence, Apps-Side Cache Sizing](0019-storage-and-pipeline-operations.md) | Accepted | 2026-06-20 |
| 0020 | [CI/CD & Conformance Test Orchestration — GitHub Actions, Inferno + UDAP Test Gating Split, Three-Layer TS/Python Lockstep, Three-Channel Flighting, Hybrid Workspace Topology](0020-cicd-and-conformance-test-orchestration.md) | Accepted | 2026-06-20 |
| 0021 | [Install, Audit, and Runbooks — Hybrid Install Script, `installation_audit` Schema, Cost-Conscious Monitoring, Unified Operator CLI, `$everything` Gate Ratification, Educational-Materials Bundle Structure](0021-install-audit-and-runbooks.md) | Accepted | 2026-06-20 |
| 0022 | [Standalone Storage — Clean-Room Columnar Flattening on OSS Delta, Layering B, and the Catalog/Governance Seam](0022-standalone-storage-flattening-and-catalog-seam.md) | **Accepted** (feasibility-validated; catalog binding deferred to 0025. RoninStandAlone first divergence ADR; supersedes ADR-0010 dbignite specifics for the standalone product) | 2026-06-27 |
| 0023 | [Open-Source Licensing — Apache-2.0 Core + Open-Core Proprietary Modules](0023-open-source-licensing-and-open-core-model.md) | **Proposed** (recommends Apache-2.0; needs Chad ratification + IP-attorney review) | 2026-06-27 |
| 0024 | [Clean-Room R4 Columnar Schema Generator — Mapping Spec](0024-clean-room-r4-columnar-schema-generator.md) | **Accepted** (POC-validated across all 146 R4 types) | 2026-06-27 |
| 0025 | [Catalog / Governance Binding Seam](0025-catalog-governance-binding-seam.md) | **Proposed** (path-based default + Unity Catalog OSS first; resolves 0022 §5) | 2026-06-27 |
| 0026 | [Medallion Promotion Orchestration — Delta CDF, No DLT](0026-medallion-promotion-orchestration.md) | **Proposed** (supersedes ADR-0019 §7 DLT for standalone) | 2026-06-27 |
| 0027 | [Governed View Layer — SQL-on-FHIR v2 ViewDefinitions](0027-governed-view-layer-sql-on-fhir.md) | **Proposed** (future / demand-gated) | 2026-06-27 |
| 0028 | [Cross-Product Platform Alignment — One Engine (delta-rs/DataFusion) + One Protocol Tier (TS/Hono) Across Ronin + RoninStandAlone](0028-cross-product-platform-alignment.md) | **Accepted** (direction ratified 2026-06-28; Ronin migration gated on delta-rs-on-Databricks-UC spike) | 2026-06-28 |
| 0029 | [Runtime & Stack — TypeScript/Node + Hono (ratifies the un-ratified stack)](0029-runtime-and-stack.md) | **Accepted** (2026-06-28; supersedes Rejected ADR-0002) | 2026-06-28 |
| 0030 | [Standalone Security, Privacy & Consent — server-side enforcement](0030-standalone-security-privacy-consent-enforcement.md) | **Accepted** (2026-06-28) | 2026-06-28 |
| 0031 | [TLS & Transport Security Policy](0031-tls-and-transport-security.md) | **Accepted** (2026-07-04) | 2026-07-04 |
| 0032 | [Production Security Profile & Fail-Closed Enforcement](0032-production-security-profile.md) | **Accepted** (2026-07-04) | 2026-07-04 |
| 0033 | [HTTP-Tier Hardening (headers, CORS, rate limiting, body limits)](0033-http-tier-hardening.md) | **Accepted** (2026-07-04) | 2026-07-04 |
| 0034 | [Supply-Chain Security — SBOM & Dependency Scanning](0034-supply-chain-sbom-dependency-scanning.md) | **Accepted** (2026-07-04) | 2026-07-04 |

## Queued (not yet drafted)

- 000X: Replacement runtime/stack ADR (post-storage-shape; narrowed scope per ADR-0009 — TS server is the primary v1 runtime, Python/Spark tier is the bulk-ingest + projection home per ADR-0011)
- ~~v1 conformance targets ADR~~ → **completed by [ADR-0014](0014-conformance-targets-and-ig-matrix.md)** (US Core 6.1.0 floor + IG matrix + CapabilityStatement).
- ~~Operability ADR~~ → split into three ADRs per session 019:
  - **ADR-0019 (Accepted 2026-06-20)** — Storage & Pipeline Operations: schema evolution; OPTIMIZE/VACUUM/ZORDER; three-DLT-pipeline architecture; Spark-library validator; MPI cadence; Apps-side cache sizing.
  - **ADR-0020 (Accepted 2026-06-20)** — CI/CD & Conformance Test Orchestration: GitHub Actions; conformance test gating split (hard-fail / soft-warn / manual); IG upgrade choreography; IdP test matrix mechanics; trust bundle refresh; validation transpiler + validator coordination; TS/Python lockstep three-layer mechanism; DLT + validator JAR upgrade choreography; three-channel pre-release flighting; hybrid CI workspace topology; conformance evidence bundle publication.
  - **ADR-0021 (Accepted 2026-06-20)** — Install, Audit, and Runbooks: hybrid install script (interactive first + config-replay); `gold.installation_audit` schema with 17 event types + tamper-evidence; cost-conscious monitoring via Databricks system tables + SQL dashboards + customer webhook; breach-signal alerting with auto-resolve + suppression; on-call paging templates (PagerDuty / Opsgenie / Datadog / Splunk / Sentinel / generic); 12 v1 App lifecycle runbooks; `$everything` operation-level scope + per-resource gate with `OperationOutcome` warning; educational-materials manifest-driven content-bundle structure with per-language + per-jurisdiction; unified `ronin` operator CLI across 8 activation components; gold.observability.* tables; Python wheel CLI distribution with operator-pull self-update.
- 000X: Validation rules + identifier-system normalization ADR (pluggable rule engine for FHIR profiles)
- 000X: Cross-resource Bundle transaction scope (v1 ships single-resource-type Bundles per ADR-0011 Amendment 1 §change 3; cross-resource Bundle support deferred pending Delta multi-table commit story + customer demand). When this ships, MPI-aware reference resolution semantics need ratification per ADR-0012 follow-up.
- 000X: Gold→Bronze reconciliation pipeline shape (streaming CDF vs periodic job; per ADR-0011 Amendment 1 §2.2; small POC required before operability sizing locks).
- 000X: Transaction Bundle cross-table atomicity (current posture: FHIR-loose; revisit if customer requirements demand)
- 000X: Survivorship rules sub-decision (per-field defaults during patient merge; per ADR-0012 follow-up; small operability sub-note)
- 000X: FHIR Person resource support (v2.x consideration if federation use cases materialize; per ADR-0012 alternatives)
- 000X: Provider Access attribution data filter ADR (third compartment dimension alongside Patient compartment + SLS; needed for Provider Access by 2027-01-01; per Coverage research §7 + OQ5 — next-available ADR candidate; 0022 now taken by standalone storage)
- 000X: ADR-0014 Coverage profile pack additions — HRex Coverage + C4DIC-Coverage + R5 Coverage (per Coverage research §3 / §4 / §12; "up to 5 concurrent profile surfaces" surfaced session 020)
- 000X: InsurancePlan resource (v2 or v1.x — R5 Coverage adds a Reference to InsurancePlan; per Coverage research OQ4)
- 000X: R5 Coverage support (v1 or v1.2 — breaking `payor` → `insurer` rename + new `kind` + `paymentBy` + `insurancePlan` fields per Coverage research §4 / OQ3; needs separate `gold.coverage_r5_current` projection)
- ~~DLT pipeline bundle ADR + POC~~ → **completed by [ADR-0019 §7](0019-storage-and-pipeline-operations.md)** (three DLT pipelines declared in the DAB; first practical DLT-in-bundle exercise).
- 000X: OpenTofu module ADR (SFTP storage bucket + cloud-provider event notifications + optional Datavant Connect + optional OAuth IdP wiring; per ADR-0013 follow-ups)
- 000X: Marketplace listing publication ADR (packaging conventions, version-compatibility matrix, listing review cadence, support model; per ADR-0013 follow-ups)
- 000X: Cloud marketplace listings ADR (Azure / AWS / GCP marketplace SaaS Offer / Managed Application listings; v1.x procurement convenience; per ADR-0013)
- ~~Customer onboarding script ADR~~ → **`scripts/ronin-install.sh` final shape ratified by [ADR-0021 §1](0021-install-audit-and-runbooks.md)** (hybrid interactive + config-replay + update modes; idempotent 12-step install plan). Per-cloud install wrappers (Azure / AWS / GCP Marketplace SaaS Offers) remain queued.
- 000X: Standard-workspace create-warehouse path validation POC (per ADR-0013 §4 deferred validation; Chad's GCP account in progress)
- ~~0014: Conformance Targets and IG Matrix~~ → **Accepted as ADR-0014.**
- ~~0015: Validation Architecture~~ → **Accepted as ADR-0015.**
- ~~0016: Audit and Access Transparency~~ → **Accepted as ADR-0016.**
- ~~0017: Terminology Service~~ → **Accepted as ADR-0017** (2026-06-20). Anchored to three-leg stack (FHIR core R4 + Terminology Ecosystem IG 1.9.1 + THO 7.2.0 per ADR-0014 Amendment 1); pure-local resolution; six Delta tables (codesystem_header/concept/property, valueset_definition/expansion, conceptmap); `silver.validation_provenance` for binding pins; `terminology_artifacts` pin + operator-flip activation; `content = not-present` handling; Apps LRU + warehouse two-tier read path; FHIR REST surface per Ecosystem IG.
- 000X: DAR fill + clinical plausibility DQ rules — multi-session discovery thread (taxonomy first; per-category rule design follows; per validation-architecture note §3.4)
- 000X: ADR-0010 Amendment 4 — denormalized security columns (`confidentiality_level`, `sensitivity_tags`, `policy_tags`, `classified_at`, `classified_by_rule_version`) added to Silver/Gold tier schemas per [ADR-0015 Amendment 2 §A2.2](0015-validation-architecture.md). Small footnote amendment; can land standalone.
- 000X: Validator-throughput POC (`poc/validation-throughput-poc/`) — measures Pattern A and SQL-substrate throughput; blocked on GCP Standard workspace
- 000X: ~~Foundations + CMS-2027 notes update~~ — **Done session 018**; all clusters A–H1 resolved and folded into the foundations note + CMS-2027 note + validation-architecture note.
- 000X: Multi-stakeholder Prior Authorization workflow research thread — CRD / DTR / PAS + clearinghouse integration (Availity / ChangeHealthcare / Waystar) + UM vendors (Cohere / Optum / eviCore); design Ronin's role across payer / provider EHR / clearinghouse / UM-vendor boundary; X12 278 bridge vs direct FHIR PAS; per session-018 cluster H2.
- 000X: TEFCA participation ADR — QHIN onboarding flow, per-QHIN trust framework, consent-attestation grammar, audit export schedules; referenced from ADR-0012 §6 and ADR-0016 §8.1; depends on TEFCA framework evolution.
- ~~`gold.installation_audit` table design~~ → **completed by [ADR-0021 §2](0021-install-audit-and-runbooks.md)** (17-event catalog + tamper-evidence + indefinite retention).
- 000X: Legacy format transformation research thread — CCDA on FHIR; HL7v2 to FHIR; ECDS (HEDIS quality measures); X12 flat file; comparison to Azure $convert-data + Google Cloud Healthcare API transformations; Databricks-native at-scale story leveraging concept maps + terminology server. Triggered session 018 close.
- 000X: Terminology-as-separable-product positioning note — FHIR Terminology Services IG conformance commitment + standalone Marketplace product framing; sets up ADR-0017 (per session-018 cluster E).
- 000X: Federated-store competitive positioning callout — Ronin solves the multi-store federation problem that drives multi-million-dollar consulting at Azure FHIR Service customers; surface in ADR-0013 v1.x update + ADR-0016 (per session-018 cluster F).
- 000X: delta-rs migration ADR (when UC managed-Delta external write goes GA; v2+ interactive write path replacement)
- 0003: Catalog choice — **collapsed by ADR-0009**: Unity Catalog (Databricks-managed) is the default. May still be drafted as a 1-page record.
- ~~0005: Search execution model~~ → **Accepted as ADR-0005** (2026-06-20). Hybrid execution: patient-bound → Patient compartment; high-traffic population → Layer 4c search-index; ad-hoc → direct `*_current` scan. Three-tier parameter coverage (US Core/FHIR base must; chained / `_has` / custom / `_query` / full-text v1.x; GraphQL out of v1). `_include` / `_revinclude` with 100-row per-resource-type cap. `Bundle.total` estimate-by-default + `_total=accurate` opt-in. Population QPS limit (10 qps default; patient-bound exempt). Patient-bound p95 < 500 ms. Consent gate post-filter `Bundle.total` (no leak).
- ~~0006: SMART on FHIR + UDAP specifics~~ → **Accepted as ADR-0006** (2026-06-20). Three-leg conformance stack (SMART App Launch 2.0+ / FHIR core OAuth2+OIDC / UDAP SSRAA 1.0.0); v1 ships both SMART + UDAP; hybrid UDAP gateway (inline default + delegated to customer-hosted, per-deployment configurable); customer-supplied OIDC IdP with explicit Login.gov + id.me recognition; five-point scope+consent enforcement (consent gate point 5 cross-references ADR-0018).
- ~~0018: Patient Portal + Consent + Read-Time Filter~~ → **Accepted as ADR-0018** (2026-06-20). Patient portal as separate Ronin App with full discovery; three capture surfaces (portal / customer-existing / back-office); standard FHIR Consent storage in gold.consent_r4_current; multi-level security gate using meta.security labels from ADR-0015 Amendment 2 SLS; v3-ActReason PPOU vocabulary + Ronin extension for CMS P2P; no-cache enforcement for v1; portal v1 scope = opt-out for Provider Access, opt-in for Payer-to-Payer, view/revoke, connected apps, educational materials; back-office API only in v1; TypeScript/React themed App + headless contract documented.
- 0007: Iceberg compatibility shape — **deprioritized by ADR-0009**: Databricks Uniform handles Iceberg-as-output; not a property of Ronin's operational storage.
- 000X: Foundation services boundary for TS server (single portable core in Rust/Go with bindings vs. dual TS+Python in spec lockstep)
- 000X: Hard-delete / GDPR right-to-be-forgotten (if customer requirements demand)
- 000X: Patient compartment refresh policy tuning (Layer 4b active-window definitions, per-deployment overrides)
- 000X: 837/835 X12 ingest (likely v1.x; confirm with Chad before locking)

## Retired queue items

- 0004 (history/versioning model on Delta): subsumed by append-only design from ADR-0010.
- 0004a (dbignite vs. Pathling encoder schema reconciliation): premise depended on ADR-0002 which was Rejected.
- "Amend ADR-0001": completed by ADR-0008.
- "Storage shape ADR" queued item: completed by ADR-0010.
- "Polyglot write contract ADR" queued item: completed by ADR-0011.

## v3/v4 (out of v1, primary need not yet scoped)

- Python/PySpark **analytics tier** — interactive analytics, SoF v2 production execution, terminology batch services, advanced bulk submit, ML feature engineering. The v1 ingest Python footprint (per ADR-0009 Amendment 4 third revision and ADR-0011) overlaps the analytics tier's runtime/dependencies; the line is workload posture (v1 = ingest + projection; v3/v4 = interactive analytics + AI/ML), not language.
- Delta Sharing inbound/outbound — nice-to-have per Chad's session-010 positioning review; v2 candidate.
- HL7v2 message-feed ingest — interface-engine-upstream pattern remains the customer's responsibility; v2/v3 if direct ingest becomes a feature request.
