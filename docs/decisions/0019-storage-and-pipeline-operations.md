# ADR-0019: Storage & Pipeline Operations — Schema Evolution, OPTIMIZE/VACUUM/ZORDER, Three-DLT-Pipeline Architecture, Spark-Library Validator, MPI Cadence, Apps-Side Cache Sizing

- Status: **Accepted**
- Date: 2026-06-20
- Decider(s): Chad
- Session: 019
- Related: [ADR-0010](0010-storage-shape.md) (Amendments 1+2+3), [ADR-0011](0011-write-contract.md) (Amendments 1+2+3), [ADR-0012](0012-master-patient-index.md), [ADR-0013](0013-deployment-posture.md), [ADR-0014](0014-conformance-targets-and-ig-matrix.md) (Amendment 1), [ADR-0015](0015-validation-architecture.md) (Amendment 2), [ADR-0016](0016-audit-and-access-transparency.md), [ADR-0017](0017-terminology-service.md), [ADR-0018](0018-patient-portal-consent-and-read-time-filter.md)

## Context

After ADRs 0010–0018, the Ronin v1 architecture has shape but not yet operational decisions. Across that ADR slate, ten distinct operational concerns accumulated as "Operability ADR" pointers. ADR-0019 absorbs the storage and pipeline subset (clusters O1, O2, O5, O6, O9 from the session-019 sweep); ADR-0020 takes CI/CD + conformance test orchestration; ADR-0021 takes install, audit, and runbooks.

This ADR commits to the architectural shapes — schema-evolution policy, DLT pipeline structure, OPTIMIZE/VACUUM cadences, MPI operational rhythms, cache sizing. Concrete tuning constants that depend on workload-specific POCs (validation throughput, Splink throughput at payer scale) ratify as Amendment when those POCs unblock; the shape commitments don't change.

**What ADR-0019 explicitly excludes** (lives in ADR-0020 or ADR-0021):

- CI/CD pipeline mechanics + IG upgrade choreography + Inferno/UDAP test orchestration → ADR-0020.
- TS / Python write-path lockstep mechanics → ADR-0020.
- Install script shape + `gold.installation_audit` table design + customer-visible runbooks → ADR-0021.
- Monitoring + alerting + on-call + SIEM templates → ADR-0021.
- `$everything` operation gate semantics ratification → ADR-0021 (or small amendment to ADR-0018).
- Educational materials content-bundle structure → ADR-0021.

## Decision

### 1. Schema evolution policy — hybrid (additive in-place, breaking via new tables)

Delta supports schema evolution natively, but evolving table schemas at payer scale (10M-member, ~1B Observation rows over 5 years) needs explicit policy to avoid breaking concurrent reads and `_history` queries.

**Additive changes** — new columns added to existing tier tables via `ALTER TABLE ... ADD COLUMNS`. Existing rows return NULL for the new column; readers using `SELECT *` see the NULL; `_history` queries against pre-amendment rows see the NULL with no error. Used for:

- Denormalized lookup columns (`confidentiality_level`, `sensitivity_tags` per ADR-0015 Amendment 2 §A2.2; `purpose_codes`, `actor_references`, `applies_to_security_labels` per ADR-0018 §1).
- New optional fields added by FHIR R4 erratum or US Core minor-version updates.
- Internal Ronin metadata extensions (rule-set version pins, classification timestamps).

**Breaking changes** — new tables per FHIR profile version. The transpiler (ADR-0015 §3) creates the new table on IG upgrade; existing tables remain readable for `_history` queries against older rows; reads against the new profile use the new table. Used for:

- FHIR core version climb (R4 → R5 → R6).
- US Core major version bump that changes required-field cardinality or core type.
- Profile renaming or canonical URL change.

Forward-only: data is never back-rewritten across the schema boundary. Rolls into the `validation_artifacts` IG-version-pin pattern (ADR-0014 §3 + ADR-0015 §7) so the active table is always selected by the request's resource type + FHIR version + profile pin.

### 2. OPTIMIZE / VACUUM cadence + retention

| Table family | OPTIMIZE cadence | VACUUM retention | Override variable |
|---|---|---|---|
| Medallion transactional (Bronze + Silver + Gold + `*_current` projections) | **Daily** off-hours (per-deployment timezone) | **24 months** | `ronin_optimize_schedule_medallion`, `ronin_vacuum_retention_medallion` |
| Audit (AuditEvent + access log + OAuth events per ADR-0016) | **Weekly** off-hours | **24 months** (matches tamper-evidence window) | `ronin_optimize_schedule_audit`, `ronin_vacuum_retention_audit` |
| Terminology (per ADR-0017 §4) | **Weekly** off-hours (low write rate) | **7 days** for ephemeral; **24 months** for active versions | `ronin_optimize_schedule_terminology` |
| MPI (per ADR-0012) | **Daily** off-hours (high churn during ingest) | **24 months** | `ronin_optimize_schedule_mpi` |
| Ephemeral working tables (intermediate Silver staging when materialized) | None scheduled (recreated per pipeline run) | **7 days** | n/a |

**Why 24-month VACUUM retention is the floor for transactional + audit tables**: ADR-0016 §4 establishes Delta time-travel as part of the tamper-evidence story; the 24-month transaction log window is what auditors can replay. VACUUM removing files outside that window is acceptable; inside, it breaks the tamper-evidence guarantee.

OPTIMIZE includes ZORDER refresh per §3.

### 3. ZORDER columns per table family

| Table family | ZORDER columns | Rationale |
|---|---|---|
| `*_current` Layer 3 projections (per ADR-0010 §4) | `(patient_id, fhir_id)` | Point reads on `(compartment, resource)` are the dominant path |
| History-tier tables (Bronze, Silver, Gold pre-projection) | `(patient_id, last_updated)` | `_history` queries paginate by recency |
| Audit tables (per ADR-0016 §2.3) | `(patient_id, recorded)` | Patient-transparency view + breach pattern detection |
| `terminology_codesystem_concept` (per ADR-0017 §4) | `(system_url, code)` | `$lookup` point reads |
| `terminology_valueset_expansion` (per ADR-0017 §4) | `(valueset_url, valueset_version, expansion_id)` | `$expand` partition scans |
| MPI cluster table (per ADR-0012) | `(patient_id, golden_id)` | Cluster resolution at read time |
| `validation_provenance` (per ADR-0015 §A2 + ADR-0017 §5) | `(resource_id, version_id)` | Joined per-resource at historical reads |

Partitioning per the originating ADRs (`system_url` for terminology concepts; year-month for audit; etc.) is upstream of ZORDER and unchanged here.

### 4. Storage growth budget shape per deployment profile

Per deployment profile budget envelopes (compressed Delta). These are shapes for capacity planning, not tuning constants — customer FinOps owns concrete provisioning.

| Component | `payer_baseline` (10M-member) | `provider_baseline` | `strict_federal` |
|---|---|---|---|
| Audit tables (per ADR-0016) | 2–5 TB/year | 0.5–1.5 TB/year | 2–7 TB/year (extended retention) |
| Medallion (all resource types) | 1–5 TB/year | 0.3–1.5 TB/year | 1–5 TB/year |
| Validation artifacts | tens of GB | tens of GB | tens of GB |
| Terminology (per ADR-0017) | 5–15 GB | 5–15 GB | 5–15 GB |
| MPI tables | 50–100 GB | 20–50 GB | 50–100 GB |
| `validation_provenance` (per ADR-0017 §5 + ADR-0015 §A2) | 100–500 GB/year | 30–150 GB/year | 100–500 GB/year |
| **Total** | **~5–12 TB/year** | **~1.5–4 TB/year** | **~5–14 TB/year** |

`strict_federal` audit multiplier reflects extended-retention regulatory regimes (per ADR-0014 deployment profiles). The medallion footprint is dominated by AuditEvent + Observation + ExplanationOfBenefit — order of magnitude consistent with HAPI / Aidbox payer deployments at equivalent scale.

### 5. DLT pipeline architecture — three pipelines, resource-type as parameter

The validation pipeline from ADR-0015 §3 has three logical stages: Bronze field check (Layer A), Bronze→Silver Governance (Layers B + C + C-prime SLS per ADR-0015 Amendment 2), Silver→Gold blessing. ADR-0019 commits to:

**Three separate DLT pipeline definitions** in the DAB, one per stage:

```
dlt_pipeline.bronze_field_check
dlt_pipeline.bronze_to_silver_governance
dlt_pipeline.silver_to_gold_blessing
```

Each takes **resource type as a parameter** rather than declaring one pipeline per resource type. Pattern: pipeline reads from the partition-pruned upstream tier table (already isolated by `resource_type` column); processes; writes to the same-partitioned downstream tier table. Fewer cluster objects to manage; partition pruning already at storage handles per-resource-type isolation; cluster autoscale handles per-resource-type load variance.

**Per-layer streaming vs. job mode** (ratifying ADR-0010 + ADR-0011 decisions in one place):

| Pipeline | Mode | Trigger |
|---|---|---|
| Bronze ingest (per ADR-0011 bulk write path) | Triggered streaming | File arrival (Auto Loader) |
| `bronze_field_check` | Continuous streaming | Bronze writes |
| `bronze_to_silver_governance` | Continuous streaming | Bronze field check output |
| `silver_to_gold_blessing` | Continuous streaming | Silver Governance output |
| Layer 3 `*_current` projection (per ADR-0010 §4) | Continuous streaming via CDF | Gold writes |
| Layer 4b NDJSON rendering (per ADR-0010 §4) | Nightly Job | Schedule (active-window definitions from compartment-file-poc) |

DLT-in-bundle pattern (queued from ADR-0013 follow-ups): all three DLT pipelines declared in the DAB. First practical exercise of `databricks_pipeline` resource in the bundle.

### 6. DLT cluster sizing shape per deployment profile

| Profile | `bronze_field_check` | `bronze_to_silver_governance` | `silver_to_gold_blessing` | Layer 4b nightly |
|---|---|---|---|---|
| `payer_baseline` | Autoscale 2–8 Photon workers; sized to ingest spike | Autoscale 2–4 Photon workers | Autoscale 2–4 Photon workers | Fixed 4-node burst, ~30 min nightly |
| `provider_baseline` | Autoscale 1–4 Photon workers | Autoscale 1–2 Photon workers | Autoscale 1–2 Photon workers | Fixed 2-node burst |
| `strict_federal` | Same as payer_baseline | Same as payer_baseline + extended audit logging | Same as payer_baseline | Same as payer_baseline |

These are envelopes; concrete cluster configurations land as Amendment when the validation throughput POC (queued in ADR-0015 §8) unblocks. Per ADR-0009 Photon as the runtime baseline; per ADR-0011 Photon shines on the SQL-substrate validation work.

### 7. DLT-in-bundle pattern — first practical exercise

The DAB ships:

```
resources/dlt_bronze_field_check.yml
resources/dlt_bronze_to_silver_governance.yml
resources/dlt_silver_to_gold_blessing.yml
```

Each declares the pipeline via `databricks_pipeline` resource (DAB GA), referencing the Python notebook or SQL file that implements the stage. Pipeline definitions parameterize the cluster size from the `var.deployment_profile` variable (payer_baseline / provider_baseline / strict_federal). DAB deploy flips the cluster size per the chosen profile.

This is the first DLT-in-bundle exercise referenced from ADR-0013 follow-ups; deletes the queued item, establishing the pattern for future operational DLT additions.

### 8. HL7 Validator as Databricks Spark library

ADR-0015 §3.5 rejected the "in TS REST server in-process" option for the JVM Validator. ADR-0019 ratifies the remaining alternative.

**Deployment mode**: Databricks Spark library installed in the `bronze_to_silver_governance` DLT pipeline's cluster. Invoked as a per-resource UDF on Layer C surgical-residual rows (~5% per ADR-0015 §3.5).

**IG-version pin coordination**: the validator UDF reads the active IG version pin from `validation_artifacts` (per ADR-0015 §7) at DLT startup. When the pin changes (operator activation per ADR-0014 §3), the DLT pipeline restarts as part of the standard pin-change choreography — the new validator JAR is loaded with the new IG package. Concrete restart trigger lives in ADR-0020 (CI/CD).

**Library versioning**: the validator JAR is shipped with the bundle (`scripts/validators/hapi-validator-<version>.jar`); per-deployment override via `ronin_validator_jar_path` for customers needing custom builds.

**Why Spark library, not a separate JVM process**: operational simplicity (one cluster managed, not two); throughput-scales with the existing Spark cluster; same lifecycle as the rest of the validation pipeline. The "JVM-in-Node-process is operationally fragile" finding from ADR-0015's alternatives section applies broadly — keep JVM out of the Apps surface.

### 9. MPI operations defaults

| Setting | Default | Override variable |
|---|---|---|
| Splink EM retraining cadence | **Quarterly** (operator-pulled; not auto-trigger) | `ronin_splink_em_retrain_schedule` |
| Splink Spark job sizing — `payer_baseline` | Autoscale 4–16 Photon workers; sized to monthly retrain volume | `ronin_splink_cluster_*` |
| Splink Spark job sizing — `provider_baseline` | Autoscale 2–8 Photon workers | same |
| Stewardship new-pair review SLO | **24h p50 / 72h p95** | `ronin_stewardship_new_pair_sla` |
| Stewardship batch review SLO | **Weekly p95** | `ronin_stewardship_batch_review_sla` |
| MPI table schema migration | Same hybrid policy as §1 | n/a |

Splink retraining is operator-pulled (mirrors ADR-0014 IG version + ADR-0017 terminology activation patterns): the EM retraining Job materializes new model weights; operator inspects + activates via `ronin mpi activate-model <version>`. Prior model retained for rollback per ADR-0012 §9.

Stewardship SLOs are *targets*; alerting wiring is in ADR-0021. The targets themselves are operational commitments here.

### 10. Apps-side cache sizing per deployment profile

| Cache | Default | `payer_baseline` | `strict_federal` | `provider_baseline` |
|---|---|---|---|---|
| Terminology pre-warm max codes (`ronin_terminology_prewarm_max_codes` per ADR-0017 §8) | **5000** | 5000 (no change) | **2500** (less to cache; security posture) | 5000 |
| Token introspection cache TTL (per ADR-0006 §6) | **60 s** | 60 s | **30 s** (faster revocation propagation) | 60 s |
| Consent cache | **None** (per ADR-0018 §5.3) | n/a | n/a | n/a |
| `compute_clearance` UC Function result cache (per ADR-0015 Amendment 2 §A2.6) | **None** (per-request; no caching) | n/a | n/a | n/a |
| OIDC public-key cache (per RFC 9068 / standard JWK practice) | **24 h** | 24 h | **1 h** (faster rotation propagation) | 24 h |

Consent cache and clearance-computation cache stay off for v1 by ADR-0018 design; revisit in v1.x with explicit cache invalidation when load testing surfaces the cost.

## Consequences

**What this commits Ronin to:**

- Three-DLT-pipeline architecture is locked. Adding a new validation tier means adding a fourth DLT pipeline, not changing the existing ones' shape.
- Schema evolution is forward-only across breaking changes — operationally simpler but means R4 → R5 climb requires running both R4 tables and R5 tables for the time-travel window.
- OPTIMIZE / VACUUM windows are fixed per-table-family — customers can shift the off-hours timezone but can't materially reduce the OPTIMIZE frequency without performance penalty.
- HL7 Validator JVM lives only on the Spark cluster; no Apps-side JVM surface anywhere in v1.
- MPI retraining is operator-pulled by default — no auto-retrain; customers without dedicated MPI ops staff feel this.

**What it enables downstream:**

- The DLT-in-bundle pattern is now exercised; future operational DLT additions (Gold→Bronze reconciliation pipeline, SLS re-classification job, terminology refresh job) reuse the pattern.
- ADR-0020 can reference §5 and §8 as the build targets for CI/CD coverage.
- ADR-0021 can reference §9 SLOs as the alerting + on-call targets.
- The validation throughput POC (queued in ADR-0015 §8) now has a concrete shape to bench against.

**What it costs:**

- Three DLT pipelines means three cluster objects, three DAB resources, three monitoring surfaces. Mitigated by the resource-type-as-parameter decision keeping pipeline count at exactly three.
- 24-month VACUUM retention is non-negotiable for the tamper-evidence story but inflates Delta storage by ~30–50% vs. 7-day default. Mitigated by Delta compression + payer-scale economics still favorable.
- POC-blocked tuning constants (§6, §9) mean v1 GA defaults are conservative envelopes; customer-specific tuning is a deployment-time concern.
- Operator-pulled MPI retraining adds an operational task; v1.x auto-trigger remains queued.

## Alternatives considered

- **Per-resource-type DLT pipelines** (one DLT per FHIR resource type). Rejected — explodes cluster count; partition pruning at storage already isolates resource types; operational complexity not justified.
- **Single unified validation DLT pipeline** with all three stages collapsed. Rejected — per-stage cluster sizing is meaningfully different (Bronze field check is ingest-spike-bound; Governance is steady-state); collapsing loses tuning resolution.
- **JVM Validator as App-side sidecar**. Rejected — ADR-0015 §3.5 alternatives ruled out the in-Node-process pattern; App-side JVM as a separate process has the same operational fragility plus an additional Apps surface to maintain.
- **Auto-trigger Splink EM retraining** on Patient table growth threshold. Rejected for v1 — change-management hook removed; quarterly cadence is industry-standard at payer scale; auto-trigger is a v1.x knob if customer demand surfaces.
- **7-day VACUUM retention everywhere** (Delta default). Rejected — breaks ADR-0016 tamper-evidence guarantee; 24-month is the floor for transactional + audit tables.
- **Aggressive consent cache + clearance cache from day one**. Rejected by ADR-0018 — correctness vs. latency in v1; revisit in v1.x.

## Follow-up ADRs queued

- **ADR-0019 Amendment 1: Tuning constants from validation throughput POC** — folds concrete cluster sizing into §6 when the POC unblocks (currently blocked on GCP per ADR-0013 follow-ups).
- **ADR-0019 Amendment 2: Splink throughput POC results** — folds concrete sizing into §9.
- **Auto-trigger MPI retraining** — v1.x knob if customer demand surfaces.
- **Aggressive cache layer for consent + clearance** — v1.x; depends on load testing data.
- **Gold→Bronze reconciliation pipeline** (queued from ADR-0011) — adds a fourth DLT pipeline following the §5/§7 pattern.
- **SLS re-classification Job DLT pipeline** (per ADR-0015 Amendment 2 §A2.4) — additional pipeline for relabeling on rule change.

## Open questions not closed by this ADR

- **Schema migration POC** — Delta's concurrent-read guarantee on `ALTER TABLE ADD COLUMNS` at 1B-row scale needs empirical verification. Small POC worth running before v1 GA. Not an ADR-0019 blocker; documented as queued POC.
- **DLT pipeline upgrade choreography** — when a pipeline's Python code changes, how does the running pipeline get the new code? DLT supports `serverless` mode with hot-reload semantics; concrete sequence lives in ADR-0020 (CI/CD).
- **Photon cost vs. classic runtime trade-off at small `provider_baseline` deployments** — Photon's per-DBU premium may be unjustified at low throughput. Revisit when first provider customer deploys.
- **MPI table partition strategy** — `(patient_id_hash_bucket, year_month)` is the natural shape, but cluster-key Delta tables may be the better long-term answer. Revisit when cluster-key features GA in Databricks.
- **Validator JAR custom-build distribution** — customers needing the `validator_cli` JAR built with extra IG packages (federal-specific bundles) need a distribution path. Likely UC volume + `ronin_validator_jar_path` override; concrete mechanism in ADR-0020.

## Sources

- [Delta Lake — Optimize and Z-Order (Databricks docs)](https://docs.databricks.com/aws/en/delta/optimize.html)
- [Delta Lake — VACUUM](https://docs.delta.io/latest/delta-utility.html#vacuum)
- [Delta Lake — Schema evolution](https://docs.databricks.com/aws/en/delta/update-schema.html)
- [Databricks Asset Bundles — `databricks_pipeline` resource](https://docs.databricks.com/aws/en/dev-tools/bundles/resources.html#pipeline)
- [Delta Live Tables — Continuous vs. Triggered](https://docs.databricks.com/aws/en/dlt/processing-modes.html)
- [Splink — Operations](https://moj-analytical-services.github.io/splink/) — EM retraining patterns
- [HL7 FHIR Validator (`validator_cli`)](https://confluence.hl7.org/display/FHIR/Using+the+FHIR+Validator) — reference implementation behind §8
- ADR-0010 Amendments 1+2+3 — tier model and Patient compartment that this ADR sizes
- ADR-0011 Amendments 1+2+3 — write contract that ADR-0019 §5 orchestrates
- ADR-0012 — MPI architecture that §9 operationalizes
- ADR-0013 — deployment posture; DLT-in-bundle queued from there; §7 closes it
- ADR-0014 (Amendment 1) — IG version pin pattern reused for validator + MPI activation
- ADR-0015 Amendment 2 — SLS that joins §1 schema evolution + §5 pipeline architecture
- ADR-0016 — audit shape that §2 / §3 / §4 size for
- ADR-0017 — terminology refresh pattern mirrored in §9 MPI activation
- ADR-0018 — consent gate that depends on §10 cache decisions
