# ADR-0015: Validation Architecture — Hybrid SQL + Silver Assembled + HL7 Validator Surgical Residual

- Status: **Accepted**
- Date: 2026-06-19
- Decider(s): Chad
- Session: 018
- Related: [ADR-0008](0008-updated-vision-and-scope.md), [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md), [ADR-0010](0010-storage-shape.md) (Amendment 3), [ADR-0011](0011-write-contract.md) (Amendment 3), [ADR-0012](0012-master-patient-index.md), [ADR-0013](0013-deployment-posture.md), [ADR-0014](0014-conformance-targets-and-ig-matrix.md), [docs/research/2026-06-19-validation-architecture.md](../research/2026-06-19-validation-architecture.md), [docs/research/2026-06-19-fhir-server-foundations.md](../research/2026-06-19-fhir-server-foundations.md), [docs/research/2026-06-19-bronze-to-silver-governance.md](../research/2026-06-19-bronze-to-silver-governance.md)

## Context

Building a custom FHIR validator is hard. Slicing is especially hard. Profile-of-a-profile inheritance, discriminator-based slicing, FHIRPath invariants — the constraint surface across the 13-IG matrix ratified by ADR-0014 has hundreds of profiles with thousands of constraints, and the slicing rules across CARIN BB, PDex, and HRex on a single Patient or Coverage resource interlock in ways that don't have clean general-purpose solutions.

The session-018 framing from Chad: **"Custom validator is too hard. Slicing is hard. Ronin's strength is amazing validation work with SQL checks in the Bronze landing layer. All fields can be fully validated before promoting an entire record. The data quality rules going from Bronze to Silver will add the necessary Data Absent reasons in the individual resources before going to the final repository. Final validation before promoting to silver."**

Three architectural moves crystallized:

1. **Hybrid: SQL field-level checks for the 95% + HL7 Validator surgical residual for the 5%.** Most profile validation maps cleanly to SQL: cardinality, type, value-set bindings, simple invariants, fixed values, slicing predicates (verbose but feasible). The residual — complex FHIRPath constructs like `descendants()`, `repeat()`, `aggregate()` — routes through the HL7 Validator JVM sidecar surgically.
2. **IG-package-file-driven transpiler.** At IG-load time, the transpiler reads the full IG package (StructureDefinitions, ValueSets, CodeSystems, ConceptMaps), walks the profile inheritance chains, and emits per-profile SQL artifacts (Delta tables, UC Functions). Chad's prior experience with this pattern in Claude and Genie confirms feasibility — the IG packages even supply a lot of the value sets directly.
3. **Validation decomposed across three tiers.** Bronze field checks at landing time; Silver assembled-resource validation + DQ rules + DAR fill at the Bronze→Silver Governance step; Gold canonical store receives blessed rows. Per the ADR-0010 + ADR-0011 Amendment 3 tier model.

This ADR ratifies the architecture from the [validation-architecture research note](../research/2026-06-19-validation-architecture.md) as the v1 validator path. The IG matrix from ADR-0014 is the input; this ADR is the consumer.

## Decision

### 1. Hybrid validation substrate — SQL primary, HL7 Validator surgical residual

Validation is **decomposed into a Spark-SQL substrate (the primary path) with the HL7 Validator running surgically on the ~5% of resources whose profile claims include FHIRPath constructs the SQL transpiler can't translate.**

| Coverage | Substrate | Notes |
|---|---|---|
| ~95% of validation rules | Spark SQL + UC Functions | Generated from IG packages; runs in-Spark; no JVM dependency in the hot path |
| ~5% residual | HL7 Validator (`validator_cli` in JVM sidecar) | Only for resources whose profile claims include FHIRPath constructs the transpiler flagged as unsupported |

**Why hybrid, not all-SQL or all-validator:**

- **All-SQL** would require translating the full FHIRPath grammar — a multi-quarter engineering effort for marginal coverage gain. The ~5% residual is bounded and surgical-residual-routable.
- **All-HL7-Validator** loses the Databricks-native strengths (UC Functions for DQ + SQL checks; per-field granularity; per-row throughput at Spark scale). Performance also degrades — per-row JVM call overhead is ~100-500ms even with warm caches.
- **Hybrid** keeps the 95% on the fast SQL path with the safety of the official validator on the residual.

### 2. Four validation layers across Bronze→Silver→Gold

Per the Amendment 3 tier model (ADR-0010 + ADR-0011 A3), validation decomposes across four layers:

#### Layer A — Bronze field-level SQL checks

Run on every incoming row immediately after Bronze write. Per-field SQL predicates evaluate against the dbignite body STRUCT. Generated from IG StructureDefinitions at IG-load time.

**Dependency on terminology Delta tables:** Layer A's `ronin.terminology.validate_code` UC Function reads from `gold.terminology_codesystem_*` and `gold.terminology_valueset_expansion` Delta tables. These must be populated for value-set binding checks to work — see §10 (terminology auto-provisioning).

Coverage: cardinality (min..max), type checks, required-field presence, value-set binding (via UC Function `ronin.terminology.validate_code`), fixed values, simple FHIRPath invariants (translatable to SQL boolean expressions), identifier system canonicalization, date format / range, must-support presence (warn-not-fail).

Outcome captured on the Bronze row as `field_checks` STRUCT:

```
field_checks STRUCT<
  passed_count  INT,
  failed_count  INT,
  warning_count INT,
  issues ARRAY<STRUCT<
    severity   STRING,       -- 'error' | 'warning' | 'information'
    code       STRING,       -- 'structure' | 'required' | 'invariant' | 'value-set' | ...
    path       STRING,       -- FHIRPath
    diagnostics STRING,
    profile_url STRING,      -- which profile required this
    check_id   STRING        -- generated check identifier
  >>
>
```

`silver_eligible` boolean column derived from check outcomes (true iff `failed_count = 0`).

#### Layer B — Silver assembled-resource validation

DLT pipeline reads Bronze CDF for silver-eligible rows; runs assembled-resource checks. Generated from IG StructureDefinitions; sees the whole resource, not isolated fields.

**Dependency on terminology Delta tables:** Layer B's value-set binding checks (within slicing rules and cross-field invariants) hit the same terminology UC Functions as Layer A. ValueSet expansion lookups during validation are SQL reads against `gold.terminology_valueset_expansion`. See §10.

Coverage:
- **Slicing rules** — discriminator-based slicing across all declared profile claims; each slice satisfied independently; closed-slicing enforced where declared.
- **Profile-of-a-profile inheritance** — constraints from US Core Coverage → CARIN BB Coverage → PDex Coverage flatten at IG-load time; the runtime check applies the flattened set.
- **Cross-field invariants** — FHIRPath invariants where translatable (most non-pathological cases).
- **Profile claim coherence** — each declared profile's constraint set evaluated; per-profile OperationOutcomes emitted.
- **Reference resolution** — references resolved against `gold.identifier_index` / `patient_link` / `current_version` per Bronze→Silver Governance §D.

#### Layer C — DQ rules + DAR fill

DQ rules surface defects the structural checks (Layers A + B) can't catch — clinical implausibility, temporal inconsistency, value range, identifier format, terminology freshness. Per-rule disposition decides DAR fill, manual review hold, or hard rejection.

**Rule taxonomy** (per validation-architecture note §3.4, locked categories):

1. Profile-derived missing-field rules.
2. Clinical reference-range rules (BP, HR, temp, SpO2, LOINC reference ranges).
3. Temporal plausibility (birthDate, deceasedDateTime, encounter periods).
4. Cross-field consistency.
5. Identifier format rules.
6. Terminology freshness.

**Disposition options:** `pass` | `warn-with-DAR-fill` | `quarantine-for-review` | `hard-reject`.

**Rule design is deferred to a multi-session discovery thread** (queued per session-018; first session is taxonomy). v1 ships a stub rule set per `ronin_dq_profile` (`payer_baseline` / `provider_baseline` / `strict_clinical`); customers extend via per-deployment rule files. The integration points (Layer C in the pipeline; `validation_state.dq_outcomes` and `validation_state.dar_fills` columns on Silver) are ratified here; specific rules are not.

#### Layer D — HL7 Validator surgical residual

For resources whose profile claims include FHIRPath constructs the transpiler flagged as unsupported (~5% of typical CMS-0057 payer load), the Silver-boundary check routes the resource body through `validator_cli` running in a JVM sidecar (small Spark executor wrapper).

**Sidecar pattern:**

- Per-executor JVM with `validator_cli` + the loaded IG packages.
- Warm cache; init only once per executor lifetime.
- Per-call latency target: 100-500ms.
- Per-row routing: only resources whose `profile_url`s appear in `validation_artifacts.unsupported_invariants` (populated at transpile time).

The validator is **not the primary validator**. It's the residual safety net for the FHIRPath constructs the transpiler can't safely translate. As the transpiler matures, the residual shrinks; the HL7 Validator dependency stays narrow and replaceable.

### 3. The IG-package-file-driven transpiler

The transpiler runs at IG-package-load time (a Databricks Job triggered when the bundle's `ig_packages/` or `extra_ig_packages/` content changes per ADR-0014). It reads the **full IG package contents** and emits SQL artifacts.

**Inputs:** the full FHIR Package — StructureDefinitions, ValueSets, CodeSystems, ConceptMaps, examples, narratives. Chad's prior experience with Claude + Genie confirms: the full-package read approach works in practice; the IG packages even supply many of the value sets directly.

**Outputs (in UC):**

```
ronin_<warehouse>.silver.validation_artifacts.field_checks_<profile_canonical>      (Delta table)
ronin_<warehouse>.silver.validation_artifacts.assembled_checks_<profile_canonical>  (Delta table)
ronin_<warehouse>.silver.validation_artifacts.unsupported_invariants                (Delta table)
ronin_<warehouse>.silver.validation_artifacts.dq_rules_<profile>                    (Delta table)
ronin_<warehouse>.silver.validation_artifacts.dar_fill_rules_<profile>              (Delta table)

ronin_<warehouse>.silver.validation_functions.check_<profile>_<resource>            (UC Function)
ronin_<warehouse>.silver.validation_functions.dq_apply_<profile>_<resource>         (UC Function)
ronin_<warehouse>.silver.validation_functions.dar_fill_<profile>_<resource>         (UC Function)
```

**Per-profile artifacts** carry: source IG canonical URL + version pin, profile URL, generated SQL, transpiler version, generated-at timestamp. UC governance applies — customers audit which checks are in force per deployment.

**Transpiler implementation:** Python tool packaged with the bundle. Run via a Databricks Job triggered on IG-package change. Idempotent — reads existing artifacts; regenerates as needed. Per-IG-version artifacts coexist (the Layer 3 `ronin_ig_versions` pin from ADR-0014 selects which artifacts are active).

**Parallel terminology auto-provisioning:** the same IG-load trigger fires the terminology auto-provisioning Job (§10) — IG packages contain ValueSets and CodeSystems inline, and validation can't function until those are loaded into Delta tables. The transpiler and the terminology provisioner run in parallel; both must complete before the new IG version's validation artifacts are active.

**Inheritance chain flattening:** the transpiler walks `StructureDefinition.baseDefinition` for each profile and applies the most-restrictive constraints across the chain. PDex Coverage → HRex Coverage → US Core Coverage flatten into a single artifact for fast per-row evaluation.

### 4. Pipeline integration with Bronze→Silver→Gold

End-to-end validation flow (per validation-architecture note §3.6):

```
Bronze write commits (per ADR-0011 A1; A3 wrapped)
  ↓
Layer A — Per-field SQL checks (UC Functions from §3 transpiler outputs)
  ↓ field_checks STRUCT appended to Bronze row
  ↓ silver_eligible = (failed_count == 0)
  ↓
Bronze→Silver Governance DLT pipeline reads Bronze CDF
  ↓
For each silver_eligible Bronze row:
  Layer B — Assembled-resource SQL validation
  ↓
  Layer C — DQ rules + DAR fill
  ↓
  Layer D — Residual HL7 Validator (~5% routing)
  ↓
  MPI resolution (per ADR-0012 §1)
  ↓
  Reference resolution (per Bronze→Silver Governance §D)
  ↓
  Silver row written with full validation state + DAR-filled body
  ↓ silver_status ∈ {'pass', 'review_required', 'rejected'}
  ↓
Silver→Gold blessing pipeline reads Silver CDF
  ↓
For each silver_status='pass' Silver row:
  Promote to gold.<resource_type>_<fhir_version>
  ↓
  Gold projections materialize via CDF (Layer 2/2b/3/4)
```

The Silver row's `validation_state` STRUCT (per ADR-0010 Amendment 3) captures the full audit trail across all four layers — `field_checks`, `assembled_checks`, `dq_outcomes`, `dar_fills`, `hl7_validator_used`, `hl7_validator_outcome`, `unresolved_references`.

### 5. Per-deployment validation strictness

Per ADR-0014 §4 deployment profiles, validation strictness is per-deployment:

- **`lenient`** (default for `payer_baseline` + `provider_baseline`):
  - Must-support gaps → warning + DAR fill + promote.
  - Extensible-bound binding mismatch → warning + promote.
  - Bronze field-check failures with severity ≤ warning → promote to Silver.
  - Silver assembled-check failures with severity ≤ warning → promote to Gold.
- **`strict`** (default for `strict_federal`):
  - Must-support gaps → ERROR; row held in Silver with `silver_status='rejected'`.
  - Extensible-bound binding mismatch → ERROR; same.
  - Bronze field-check failures with any severity → held in Bronze (`silver_eligible=false`).
  - Silver assembled-check failures with any severity → held in Silver.

**Hard-deny guardrails** (per ADR-0012 §3.4) apply regardless of strictness — date-of-death mismatch, sex mismatch, SSN conflict always route to review or reject. These are safety floors, not strictness-tunable.

Deployment variable `ronin_validation_strictness = "lenient" | "strict"` overrides the profile default.

### 6. DAR fill rule integration

DAR fill rules apply between Layer C and Silver promotion. Each rule has:

```
rule_id              STRING NOT NULL
rule_category        STRING        -- one of the six taxonomy categories
profile_url          STRING        -- per-profile or global
field_path           STRING        -- FHIRPath
trigger_condition    STRING        -- SQL predicate
disposition          STRING        -- 'pass' | 'warn-with-DAR-fill' | 'quarantine-for-review' | 'hard-reject'
dar_code             STRING        -- if disposition includes DAR fill, the DAR code to apply
preserve_original    BOOLEAN       -- preserve original value in extension
rationale            STRING
```

**Application:** per-row, post-Layer-B, pre-Silver-write. The `validation_state.dar_fills` column captures the audit trail:

```
dar_fills ARRAY<STRUCT<
  path             STRING,   -- where DAR was applied
  dar_code         STRING,
  original_value   STRING,   -- preserved if preserve_original=true
  rule_id          STRING,
  applied_at       TIMESTAMP
>>
```

**v1 default rule set** ships per `ronin_dq_profile`:

- **`payer_baseline`**: profile-derived missing-field rules + minimal clinical-plausibility (BP, HR baselines); ~50-100 rules total.
- **`provider_baseline`**: provider-side missing-field + LOINC reference-range rules; ~100-200 rules.
- **`strict_clinical`**: full plausibility + cross-field consistency + identifier format; ~300+ rules.

**Customer override:** `ronin_dq_rules` deployment variable points at customer-supplied YAML/JSON rule files. Rules merge with profile defaults; customer rules win on rule_id collision.

**Rule design is multi-session discovery work** — the specific rules per category (BP ranges, temporal plausibility thresholds, identifier format regex, etc.) require multiple discovery sessions. The architecture, integration points, and audit trail ratified here support whatever specific rules emerge from that thread.

### 7. Validation transpiler upgrade choreography

When `ronin_ig_versions` changes (per ADR-0014 §3) or when the transpiler itself upgrades:

1. Transpiler runs against the new IG version set.
2. New `validation_artifacts` + `validation_functions` versioned-pinned to the new artifact set.
3. The Bronze→Silver Governance DLT pipeline picks up the new artifacts on next execution.
4. Existing Bronze rows replay through the new validation at customer election:
   - `reprocess_bronze_window` deployment variable triggers replay of a specified time window.
   - Decision deltas (validation outcomes that differ from prior pipeline version) require operator acknowledgment before applying (per ADR-0012 §9 reprocessing pattern).

Per-IG-version artifact coexistence enables incremental upgrades — old version's artifacts remain available for `_history` queries against pre-upgrade rows.

### 8. Throughput POC plan

`poc/validation-throughput-poc/` — measure Pattern A throughput against representative resources. Blocked on GCP Standard workspace per ADR-0013 §4 deferred validation; same blocker as several other POCs.

**POC scope:**

1. Transpile US Core 6.1.0 + CARIN BB 2.0.0 + HRex 1.0.0 + PDex 2.0.0 package files.
2. Generate Layer A + Layer B SQL artifacts.
3. Run against ~10K synthetic FHIR resources (Patient, Coverage, Observation, EOB).
4. Measure:
   - Layer A field-check throughput per executor (target: ≥500/sec/executor).
   - Layer B assembled-check throughput per executor (target: ≥200/sec/executor).
   - HL7 Validator residual fraction against the real-world profile claim mix (estimate from CMS-0057 payer claims).
   - HL7 Validator per-call latency (sidecar pattern, warm cache).
   - End-to-end throughput including DAR fill stubs.
5. Compare strictness modes (lenient vs strict) for throughput delta.

Output: `docs/research/2026-06-19-validation-throughput-poc-results.md` after the run informs the operability ADR's sizing.

### 9. Manual review queue surface

Silver `silver_status='review_required'` rows feed a stewardship queue per ADR-0012 §5 — already designed as `gold.patient_match_review` for MPI cases. Validation review rows extend the same pattern via a parallel `gold.validation_review` table for non-MPI hold cases (hard-deny guardrail trip; strict-mode must-support gap on a critical field; etc.).

Steward decisions flip Silver `silver_status` to `pass` or `rejected`, triggering Silver→Gold promotion or final rejection. Same UI surface as ADR-0012 MPI review (v2+ scope; v1 ships the table contract).

### 10. Terminology auto-provisioning — bridging IG packages → Delta tables

Validation Layers A and B depend on terminology being present in `gold.terminology_*` Delta tables. When an IG is activated (per ADR-0014 §2 Layer 2) or a new version is pinned (per ADR-0014 §3) or `ronin_extra_igs` adds a custom IG (per ADR-0014 §8), Ronin runs a **terminology auto-provisioning Databricks Job** that ensures the validation pipeline has the codes + value sets it needs.

**Auto-provisioning flow** (triggered on `bundle deploy` and on scheduled refresh):

1. **Parse activated IG packages.** Walk `ig_packages/` + `extra_ig_packages/` for `ValueSet`, `CodeSystem`, `ConceptMap` resources shipped inline.
2. **Check Delta tables for presence.** Query `gold.terminology_codesystem_<system>` and `gold.terminology_valueset_expansion` for each referenced canonical URL + version. Identify gaps.
3. **Load in-package terminology directly.** ValueSets and CodeSystems shipped inside the IG package extract straight to Delta tables — most IG-bound terminology is here (Chad's prior Claude + Genie experience confirms: IG packages even supply many of the value sets).
4. **Resolve VSAC-referenced ValueSets.** ValueSets whose source is NLM VSAC (`http://cts.nlm.nih.gov/fhir/ValueSet/...`) fetch via the VSAC FHIR API. **Requires customer-supplied NLM UMLS API key** (`ronin_nlm_api_key` deployment secret).
5. **Fetch external CodeSystems** per `ronin_licensed_systems` (per ADR-0014 §5 + cluster A): LOINC from loinc.org; SNOMED CT US from NLM (NLM key required); ICD-10-CM from CMS; RxNorm from NLM (key); NDC from FDA; CVX from CDC; HCPCS from CMS; CPT from AMA (paid + AMA license); X12 278 from X12 (paid + X12 license).
6. **Materialize ValueSet expansions.** Intensional ValueSets run `$expand` against the loaded CodeSystems; expanded codes write to `gold.terminology_valueset_expansion` with `expansion_id` for reproducibility (per ADR-0010 + cluster B SNOMED policy).

**Source registries used:**

| Source | Authority | Coverage | Auth |
|---|---|---|---|
| **packages.fhir.org** | HL7 official | Most IG-shipped ValueSets + CodeSystems | None |
| **packages2.fhir.org** | HL7 mirror | Same | None |
| **simplifier.net** | Firely | Community + IG mirror | None |
| **NLM VSAC** ([cts.nlm.nih.gov/fhir/](https://cts.nlm.nih.gov/fhir/)) | NLM | Canonical US ValueSets for quality measures, CMS programs | UMLS API key |
| **loinc.org** | Regenstrief | LOINC | None |
| **NLM (UMLS Knowledge Source Server)** | NLM | SNOMED CT US, RxNorm, UMLS Metathesaurus | UMLS API key |
| **CMS** | CMS | ICD-10-CM, ICD-10-PCS, HCPCS | None |
| **FDA** | FDA | NDC | None |
| **CDC** | CDC | CVX | None |
| **AMA** | AMA | CPT | Paid license + customer-supplied feed |

**NLM license key handling:**

```yaml
# Optional Databricks Secret — enables broader auto-sourcing
ronin_nlm_api_key:
  source: databricks_secret
  scope: ronin
  key: nlm_umls_api_key
```

The install script (`scripts/ronin-install.sh` per ADR-0013 §7) prompts for the NLM UMLS API key at install time:

```
Do you have an NLM UMLS API key (free with NLM registration)? [Y/n]
  This enables auto-sourcing of:
    - VSAC ValueSets (NLM Value Set Authority Center)
    - SNOMED CT US Edition
    - RxNorm
  Without it, these terminology sources require manual loading.

Enter NLM UMLS API key (will be stored as Databricks secret):
```

Without the key:
- **LOINC / ICD-10-CM / ICD-10-PCS / NDC / CVX / HCPCS / HL7 base** still load from direct sources — full functionality.
- **VSAC ValueSets** unavailable; customers must source manually or accept missing-binding warnings.
- **SNOMED CT US, RxNorm** unavailable from NLM auto-source; customers can load from cached files if they have other access.
- Validation degrades to lenient warnings on bindings against unloaded terminology per cluster A.

**Auto-provisioning trigger surfaces:**

| Trigger | Mechanism | Cadence |
|---|---|---|
| **`bundle deploy`** | Inline check of activated IGs' terminology; auto-load missing | Per deployment |
| **Scheduled refresh** | Databricks Workflow per code system | LOINC: monthly. SNOMED CT US: monthly with 30-day delay (cluster B). RxNorm: monthly. NDC: weekly. ICD-10: annual. CVX: ad-hoc. VSAC: weekly |
| **On-demand** | `ronin terminology refresh [--system <name>]` CLI | Customer-triggered |

**Failure modes:**

- **VSAC ValueSet referenced but no NLM key:** lenient — log warning + ValueSet absent from expansion table; validation against the binding degrades to lenient warning.
- **Direct-source fetch fails (network, source unavailable):** retry up to N times; if persistent, queue for next scheduled refresh; validation continues with last-known-good terminology.
- **License system not enabled** (`cpt`, `x12_278`, `snomed_international`): loader skipped; validation against bindings to those systems emits lenient warnings (cluster A).
- **VSAC API rate limit hit:** batched + paced requests; queue overage for next refresh window.

**Full design (operations, schema details, schedule mechanics, secret rotation, error recovery):** ADR-0017 (Terminology Service). This section establishes the dependency from validation to terminology provisioning; ADR-0017 ratifies the provisioning mechanism in full.

## Consequences

- **The Databricks-native validation substrate is the v1 path.** UC Functions + SQL checks become the primary validation surface; the HL7 Validator is surgical residual. This matches Chad's "Ronin's strength is amazing validation work with SQL checks in the Bronze landing layer" framing.
- **The validation transpiler is a substantial v1 engineering effort.** Estimated 3-5 months for the SQL substrate + transpiler scaffolding (per validation-architecture note §1). Critical-path work that gates v1 ship.
- **The 5% HL7 Validator residual keeps Ronin out of the "build a FHIR validator from scratch" trap.** Slicing edge cases + complex FHIRPath stay on the official validator's responsibility. As the transpiler matures, the residual shrinks; v1 starts at ~5% and v2 may push to ~2%.
- **DAR fill is the v1 differentiator.** Most servers fail rows on must-support gaps; Ronin's "promote with DAR" posture is FHIR-canonical, operator-friendly, and clinically informative. The specific rule set requires multi-session discovery; the architecture supports whatever rules emerge.
- **Per-deployment strictness is a real customer-facing choice.** `lenient` (default) maximizes ingest throughput at the cost of permissive validation; `strict` (federal-payer-grade) maximizes rigor at the cost of higher review queue depth. The deployment profile selects; per-customer override is supported.
- **Transpiler artifacts in UC give customers audit access.** Every check is queryable; every rule has provenance back to its source IG. UC privileges govern who can call which validation function. The validation surface inherits Ronin's lakehouse-native governance.
- **Reprocessing under rule/IG changes is supported but gated by operator acknowledgment** (per ADR-0012 §9 pattern). Validation deltas surface in observability; customers consent to apply.
- **DLT pipeline complexity increases.** Three distinct pipelines (Bronze field check, Bronze→Silver Governance, Silver→Gold blessing) instead of one. Operability ADR territory.
- **The transpiler is the longest-leg engineering risk in v1.** If the transpiler's FHIRPath coverage falls short of 95%, the HL7 Validator residual grows and throughput degrades. Mitigation: iterative transpiler development with measured residual percentage; throughput POC informs the actual coverage.

## Alternatives considered

- **All-SQL validator.** Rejected — full FHIRPath translation is a multi-quarter effort; the 5% residual is bounded and surgically routable. Hybrid achieves most of the SQL benefit at a fraction of the engineering cost.
- **All-HL7-Validator (Pattern A from foundations note).** Rejected — loses Databricks-native strengths; ~100-500ms per-row latency is incompatible with 10M-member-payer Governance throughput; loses the UC Functions + DQ + SQL checks surface.
- **Per-row validator-CLI subprocess (Pattern B from foundations note).** Rejected — JVM fork-per-row cost is fatal at scale.
- **Skip Bronze field checks; validate only at Silver.** Rejected — Bronze field checks are cheap, parallelize, and catch the trivial cases early so Silver-tier work only handles complex cases. The decomposition is a performance + clarity win.
- **Skip DAR fill; reject rows on missing must-support.** Rejected — clinically uninformative (fails to distinguish "we don't know" from "patient declined" from "not applicable"); breaks the "promote what you can; flag what's wrong" Ronin posture. DAR fill is canonical FHIR; using it correctly is a feature.
- **Run validation in the TS REST server in-process.** Rejected — JVM-in-Node-process is operationally fragile; Databricks Apps environment is small; Spark cluster is the right venue for validation at scale.
- **Use HAPI FHIR's InstanceValidator embedded in a Spark UDF as the primary path.** Rejected — same JVM-cost issue; HAPI's validator is well-engineered but pays the same per-row cost as `validator_cli`. The SQL substrate gets 100× the throughput.
- **Generate validation artifacts at runtime, not at IG-load time.** Rejected — runtime generation pays the cost on every request; load-time generation amortizes once per IG-version pin. The artifact storage cost is trivial.
- **Use Pathling's Spark-native validator pattern.** Considered — Pathling has interesting Spark integration but is R4-hardcoded (per ADR-0002 Rejected) and the validation pattern doesn't extend to R5/R6. Worth borrowing ideas; not a runtime dependency.
- **Customer-side validator integration (provider validator endpoint per deployment).** Rejected — moves a critical-path dependency outside Ronin; operability risk; latency cost; customer-side validator versioning becomes Ronin's problem.

## Follow-up ADRs queued

- **ADR-0016: Audit + Access Transparency** — next in sequence. Validation outcomes generate audit events (per ADR-0012 §8 pattern); Layer C DQ-fail / hard-reject events are first-class audit material.
- **ADR-0017: Terminology Service** — UC Functions referenced throughout this ADR (`ronin.terminology.validate_code` etc.); ADR-0017 ratifies them.
- **Operability ADR** — DLT pipeline orchestration for Bronze field-check + Bronze→Silver Governance + Silver→Gold blessing; transpiler Job schedule; validation review queue UI workflow; throughput-POC-informed sizing.
- **DAR Fill + DQ Discovery thread (multi-session)** — taxonomy first, then per-category rule design. v1 ships the architecture; specific rules emerge from the thread. First session queued.
- **Validation Throughput POC** — blocked on GCP Standard workspace; first POC after the workspace is available.

## Open questions not closed by this ADR

1. **FHIRPath grammar coverage in the transpiler.** Targeting ~95%; empirical measurement via the throughput POC against representative profile claims. If coverage falls below 90%, the residual + Pattern A throughput cost may rebalance the design — worth a fallback "more aggressive Pattern A use" path documented in operability.
2. **DAR fill rule format.** YAML? JSON? FHIR Rules Engine? Spark Python notebook? Likely YAML with per-rule schema validation; ratify in the DAR/DQ discovery thread.
3. **Customer-supplied DQ rule signing.** Risk: malicious customer rules could cascade across deployments. Not v1; document as a v2 consideration.
4. **Validation transpiler source language.** Python (matches the bulk-ingest Python tier per ADR-0009 Amendment 4) or Scala (matches the JVM sidecar)? Python preferred for IG package parsing libraries (`fhir.resources`, `simplifier`); ratify after a small prototype.
5. **Manual review queue retention.** Same as MPI review (per ADR-0012 OQ #3); default 7-year HIPAA-tier.
6. **HL7 Validator JVM sidecar deployment.** Databricks Spark library vs. App-side JVM process. Operability ADR.
7. **Silver row reprocessing on validation rule changes.** When DQ rules change (per the discovery thread), do existing Silver rows reprocess? Per ADR-0012 §9 pattern: operator-acknowledged delta application. Same logic applies here.
8. **`validator_cli` IG-version pin coordination.** The JVM sidecar must use the same IG version set as the SQL transpiler. Coordination via shared `validation_artifacts` Delta table at load time; concrete mechanism designed in operability.

## Sources

- [Validation-architecture research note](../research/2026-06-19-validation-architecture.md) — full design source
- [Foundations note §2 — HL7 Validator on Spark](../research/2026-06-19-fhir-server-foundations.md) — Pattern A details (now surgical residual)
- [Bronze→Silver Governance research note §E](../research/2026-06-19-bronze-to-silver-governance.md) — profile conformance activity
- [FHIR data-absent-reason extension](http://hl7.org/fhir/extensions/StructureDefinition-data-absent-reason.html) — DAR canonical codes
- [HL7 FHIR Validator (`validator_cli`)](https://confluence.hl7.org/display/FHIR/Using+the+FHIR+Validator) — reference validator implementation
- ADR-0010 + ADR-0011 Amendment 3 — Silver-reinstated tier model that hosts the validation work
- ADR-0012 §3.4 — hard-deny guardrails apply across validation strictness
- ADR-0012 §9 — reprocessing pattern reused for validation rule changes
- ADR-0013 — deployment posture; install-script integration for `ronin_validation_strictness`
- ADR-0014 — IG matrix that the transpiler consumes; deployment profiles drive strictness defaults
- Chad's session-018 framing: "Custom validator is too hard. Ronin's strength is amazing validation work with SQL checks in the Bronze landing layer."

---

## Amendment 2 — Security Labeling Service (SLS) added to Bronze→Silver Governance (2026-06-20)

**Trigger:** ADR-0018 (Patient Portal + Consent + Read-Time Filter) drafting (session 019) needed `meta.security` labels materialized on every coded resource so that `Consent.provision.securityLabel` matching has anything to match against. Without an SLS, Consent enforcement degrades to coarse-grained patient-or-API opt-out only — 42 CFR Part 2 segmentation, state behavioral-health restrictions, reproductive-health protections, and HCS confidentiality classification all become unimplementable. Per Chad's confirmation (session 019), the SLS rule engine slots into ADR-0015's existing rule-engine substrate rather than spinning out as its own ADR — the engineering reuse is too clean to split.

### A2.1 — SLS as a parallel layer in the Bronze→Silver Governance step

Adjacent to Layer C (DAR fill + DQ rules), a new **Layer C-prime** evaluates classification rules and populates `meta.security[]` on each resource before promotion to Gold. The substrate is the same:

- Rules ship per-jurisdiction baseline + customer extensions.
- Versioned + operator-flip activation (mirrors ADR-0017 §6's `terminology_artifacts` pin pattern).
- Background relabeling job when rules change.
- UC Function entry points for testability.

The rule shape:

```
classification_rule = {
  rule_id: STRING,
  rule_type: coded | value | source | location,
  resource_type: STRING (FHIR resource type, or '*' for any),
  field_path: STRING (FHIRPath against the resource),
  operator: in | equal | contains | matches,
  code_system: STRING (when rule_type = coded),
  match_values: ARRAY<STRING>,
  emit_security_labels: ARRAY<STRUCT<system: STRING, code: STRING, display: STRING>>,
  jurisdiction: STRING (HIPAA | 42CFRPart2 | <state_code> | <custom>),
  policy_reference: STRING (URL to the regulatory citation or customer policy),
  effective_period: STRUCT<start: TIMESTAMP, end: TIMESTAMP>
}
```

Example baseline rules (US Realm federal floor):

| Resource | Field | Operator | CodeSystem | Match values | Emits Sensitivity | Emits Confidentiality | Jurisdiction |
|---|---|---|---|---|---|---|---|
| Condition | code | in | ICD-10-CM | F10.*-F19.* | ETH | R | 42CFRPart2 |
| Observation | code | in | LOINC | drug screen LOINCs | ETH | R | 42CFRPart2 |
| MedicationRequest | medicationCodeableConcept | in | RxNorm | buprenorphine, methadone, naltrexone codes | ETH | R | 42CFRPart2 |
| Condition | code | in | ICD-10-CM | F20.*-F39.* | PSY | R | HIPAA-state-floor |
| Observation | code | in | LOINC | HIV viral load LOINCs | HIV | R | HIPAA-state-floor |
| Condition | code | in | ICD-10-CM | O04.*, Z33.2 | SEX | V | state-reproductive |
| * | meta.source | equal | (value) | "Planned Parenthood" | SEX | V | state-reproductive |

Customer extensions ride on top — same shape, different priority. Conflict resolution: highest confidentiality wins (the HCS total-order guarantees a deterministic outcome); sensitivity tags union (a single resource may carry multiple non-hierarchical categories per HCS).

### A2.2 — `meta.security` materialization as a Silver/Gold column

To make Consent enforcement cheap at read time, `meta.security` is materialized in two forms on every Silver/Gold resource row:

1. **Inline on the resource body** — the canonical `meta.security[]` field per FHIR R4. Returned verbatim in REST responses.
2. **Denormalized columns for filter pruning** — added by the Silver promotion step:
   - `confidentiality_level` STRING — single value (U/L/M/N/R/V) from the resource's Confidentiality tag.
   - `sensitivity_tags` ARRAY<STRING> — distinct codes from sensitivity Codings (ETH, PSY, HIV, GENDER, MH, SEX, SDV, etc.).
   - `compartment_tags` ARRAY<STRING> — distinct codes from compartment Codings.
   - `policy_tags` ARRAY<STRING> — applicable policy citations (42CFRPart2, HIPAA, state-specific).
   - `classified_at` TIMESTAMP — when the labels were last applied (drives reclassification staleness checks).
   - `classified_by_rule_version` STRING — pin to the SLS rule set version active when the labels were applied.

Reads filter against the denormalized columns via SQL `WHERE` clauses; the inline body remains the canonical-spec form. The denormalized columns are auto-generated from the inline body — no risk of drift.

### A2.3 — Confidentiality default + clearance computation

**Default confidentiality:** every resource gets exactly one Confidentiality tag per HCS rules. If no classification rule matches, the default is `N` (Normal) for US Realm HIPAA-protected data. The default is configurable per deployment via `ronin_default_confidentiality` (mostly for non-US deployments).

**Clearance computation** (used at read time by ADR-0018 §5):

```
clearance_ceiling = max(
    base_clearance_for_role(scope_grant.actor_type),
    granted_by_consent_for_requester(active_consents, requester_org),
    granted_by_policy_for_purpose(claimed_purpose_of_use)
)
permitted_sensitivities = union(
    base_permitted_for_role(scope_grant.actor_type),
    granted_by_consent_for_requester(active_consents, requester_org),
    granted_by_policy_for_purpose(claimed_purpose_of_use)
)
```

Implementation: a UC Function `ronin.security.compute_clearance(scope_grant, active_consents, purpose_of_use)` returns the tuple `(clearance_ceiling, permitted_sensitivities)`. Called once per request, then applied as a `WHERE` clause on every result-row read.

### A2.4 — Re-labeling on rule change

When the SLS rule set updates (new SAMHSA-defined codes, state law change, customer rule addition), affected historical resources need relabeling. The mechanism mirrors ADR-0012 §9's MPI reprocessing pattern:

1. **Operator activates the new rule set version** via `ronin sls activate <version>`. Default is operator-pulled, not auto-activate (per ADR-0017 §6 + ADR-0014 §3 patterns).
2. **Re-classification Job** scans Silver rows whose `classified_by_rule_version` is older than the new active version. For each affected row, the rule engine re-evaluates and writes updated `meta.security[]` + denormalized columns. Append-only model from ADR-0010: the new label state is a new resource version; old versions retain their original labels for `_history` queries.
3. **Throughput sizing** — at payer scale (10M-member-payer with ~5 years history at ~1B Observation rows), full re-classification is a multi-hour Job. Operators schedule during maintenance windows; partial re-classification (single rule, single jurisdiction) targets only affected rows.
4. **Delta surfacing** — the re-classification Job emits a `sls_reclassification_run` row per execution with counts of rows whose labels changed. Operators review before considering the rule set active for downstream consumers.

### A2.5 — Source-system label merging

Some upstream EHRs (Epic, Cerner) emit `meta.security` labels inline on outbound FHIR. The merge policy:

- **Source labels are preserved** — the SLS does not strip incoming labels.
- **SLS labels are added on top** — if a rule emits a label the source already carried, the SLS doesn't duplicate it (deduplication by `(system, code)`).
- **Conflict resolution** — highest confidentiality wins per HCS total-order. Sensitivity tags union.
- **Source provenance** — the `Provenance` resource per ADR-0012 §8 records that labels came from both source and SLS, with the rule-set version pinned.

### A2.6 — UC Function surface for the SLS

Two UC Functions exposed to validation + read-time filtering:

| Function | Purpose | Caller |
|---|---|---|
| `ronin.security.classify_resource(resource_body, rule_set_version)` → `meta_security_array` | Apply the SLS rules to a single resource body; returns the labels to apply | Bronze→Silver Governance step; on-demand validation tools |
| `ronin.security.compute_clearance(scope_grant, active_consents, purpose_of_use)` → `(clearance_ceiling, permitted_sensitivities)` | Compute the requester's effective clearance for a request | ADR-0018 §5 read-time filter |

### A2.7 — Cross-references this Amendment establishes

- ADR-0010 — Silver/Gold schemas gain the denormalized `confidentiality_level` / `sensitivity_tags` / `policy_tags` / `classified_at` / `classified_by_rule_version` columns. Documented as Storage Shape Amendment 4 (queued; minor footnote).
- ADR-0016 §2.1.1 — AuditEvent.policy[] captures applied SLS rule set version when an exclusion occurs.
- ADR-0018 §5 — read-time filter uses `compute_clearance` + the denormalized columns to evaluate Consent provisions efficiently.
- ADR-0006 §5 point 5 — cross-references the gate that depends on this Amendment's labels.

### A2.8 — Why this lands as Amendment 2 of ADR-0015, not a new ADR

The SLS rule engine is structurally identical to Layer C's DAR fill + DQ rules engine: code-system+code+source match → emit. The Bronze→Silver Governance step is already the home for rule-engine-driven transformations. Splitting SLS into its own ADR-0019 would force two separate but identical rule-engine substrates to coexist, double the operator surface (`ronin sls activate` vs. `ronin validation activate`), and obscure the engineering reuse. Per session 019 framing (Chad: "(c) is fine"), the SLS is a sibling layer of validation + DAR fill, not a separate component.
