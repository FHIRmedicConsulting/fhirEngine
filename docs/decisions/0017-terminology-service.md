# ADR-0017: Terminology Service — Delta-Backed CodeSystems, Pure-Local Resolution, Operator-Pulled Refresh, THO + Licensed-Source Layering

- Status: **Accepted**
- Date: 2026-06-20
- Decider(s): Chad
- Session: 019
- Related: [ADR-0010](0010-storage-shape.md) (Amendments 1+2+3), [ADR-0011](0011-write-contract.md) (Amendments 1+2+3), [ADR-0013](0013-deployment-posture.md), [ADR-0014](0014-conformance-targets-and-ig-matrix.md) (Amendment 1 — terminology anchor correction), [ADR-0015](0015-validation-architecture.md) (§10 auto-provisioning), [ADR-0016](0016-audit-and-access-transparency.md), [docs/research/2026-06-19-fhir-server-foundations.md](../research/2026-06-19-fhir-server-foundations.md), [docs/research/2026-06-19-validation-architecture.md](../research/2026-06-19-validation-architecture.md)

## Context

Terminology is load-bearing across the FHIR stack. Validation (ADR-0015 Layers A + B) calls `ronin.terminology.validate_code` per coded field, per row, at payer-scale ingestion. The customer-facing FHIR REST surface owes `$validate-code`, `$expand`, `$lookup`, `$translate` to any SMART app or peer payer that hits it. The Bronze→Silver Governance step depends on ConceptMap translation for vocabulary normalization. The transformation engine surfaces unmapped codes to DAR fill (ADR-0015 §3.4 Layer C). None of these run without a terminology layer that is loaded, versioned, queryable, and refreshable.

ADR-0014 set the IG conformance commitments. ADR-0015 §10 sketched the auto-provisioning Job (secrets, cadences, system list). What's still open: the operational service contract — operation surface, where ops resolve, storage layout, version pinning at read time, refresh choreography, and the THO + licensed-source layering. This ADR closes that ground.

**What was reconfirmed during this drafting** (session 019):

- There is no standalone "FHIR Terminology Services IG 1.0.0" with semantic versioning. The terminology service surface is defined across three published artifacts: the FHIR core spec (R4/R5/R6) for operations, the FHIR Terminology Ecosystem IG (continuous build 1.9.1, R5-based) for server requirements, and HL7 Terminology (THO, `hl7.terminology` 7.2.0) for content. ADR-0014's prior single-line reference is corrected in ADR-0014 Amendment 1, alongside this ADR.
- THO carries CodeSystem stubs (`content = not-present`) for licensed externals (SNOMED CT, LOINC, RxNorm, ICD-10-CM, RxNorm, CPT, NDC, CVX, HCPCS). Loading THO does not satisfy validation against those systems. The Ecosystem IG explicitly says servers SHALL NOT process `$expand` or `$validate-code` against `content = not-present` CodeSystems. ADR-0017 encodes that distinction.

## Decision

### 1. Conformance anchor stack — three layers

Ronin v1 conforms to the terminology surface as defined by:

| Layer | Source | Pinned version (v1) | What it gives Ronin |
|---|---|---|---|
| **Operations** | FHIR core spec | R4 (`4.0.1`) | `$validate-code`, `$expand`, `$lookup`, `$translate`, `$subsumes`, `$closure` operation contracts; CodeSystem / ValueSet / ConceptMap / NamingSystem resource shapes |
| **Server requirements** | FHIR Terminology Ecosystem IG (`hl7.fhir.uv.tx-ecosystem`) | 1.9.1 continuous build | TerminologyCapabilities at `/metadata?mode=terminology`; mandatory parameters (`tx-resource`, `system-version`, `check-system-version`, `force-system-version`, `inferSystem`); optional `cache-id`; OperationOutcome error coding via `http://hl7.org/fhir/tools/CodeSystem/tx-issue-type`; `x-caused-by-unknown-system` response parameter |
| **Content** | HL7 Terminology (`hl7.terminology`) | 7.2.0 | v2 tables, v3 vocabularies, FHIR-published vocabularies, stubs for licensed externals; pulled transitively via IG `package.json` dependencies |

The Ecosystem IG is R5-based; v1 Ronin serves R4. Requirements port back cleanly — the parameter and resource shapes apply across versions. R5 → R6 climb path lives in the same `ronin_ig_versions` ratchet defined in ADR-0014 §3.

### 2. Operation surface — v1 vs deferred

**v1 must-have** — implemented and CapabilityStatement-asserted:

| Operation | Resource scope | Source of truth |
|---|---|---|
| `$validate-code` | `CodeSystem`, `ValueSet` | UC Function `ronin.terminology.validate_code`; same path as ADR-0015 Layer A |
| `$expand` | `ValueSet` | Pre-materialized expansions in `gold.terminology_valueset_expansion`; on-demand expand for intensional ValueSets passed via `tx-resource` |
| `$lookup` | `CodeSystem` | `gold.terminology_codesystem_concept` point read; returns code + display + designations + properties |
| `$translate` | `ConceptMap` | `gold.terminology_conceptmap` lookup |

**v1.x (Follow-up)** — declared in CapabilityStatement as `not-supported` until shipped:

| Operation | Why deferred |
|---|---|
| `$subsumes` | Requires transitive-closure table over CodeSystem hierarchy; non-trivial for SNOMED CT |
| `$closure` | Stateful closure maintenance; v1.x candidate; documented in §10 follow-ups |

**Mandatory parameters** per the Ecosystem IG (server requirements) are implemented for `$validate-code` and `$expand`: `system-version`, `check-system-version`, `force-system-version`, `inferSystem`, `tx-resource`, `displayLanguage`, `excludeNested`, `includeDesignations`, `activeOnly`, `includeDefinition`, `property`, `designation`. `cache-id` (optional but performance-critical per the Ecosystem IG) is implemented in v1 — it's how the Apps-side LRU cache and the SQL warehouse coordinate.

**Response shape** per Ecosystem IG: errors itemized in OperationOutcome `issues` with severity, type, expression, `details.coding` from `tx-issue-type`. Successful `$validate-code` returns `result`, `system`, `code`, `version`, `display`. Validation against an unloaded code system returns `x-caused-by-unknown-system: <system_url>` and falls under cluster A lenient-warning posture (ADR-0014).

### 3. Pure-local resolution — no external terminology server delegation

Every CodeSystem the customer wants to validate against must be provisioned via the §6 refresh choreography. There is no fallback to tx.fhir.org, no federated lookup, no third-party terminology server in the request path. Unloaded CodeSystem → `x-caused-by-unknown-system` per §2 → cluster A lenient warning per ADR-0014.

**Why pure-local for v1:**

- **Operability** — no third-party dependency in the validation hot path. SLAs are Ronin's to meet, not co-owned with HL7's tx.fhir.org.
- **Cost predictability** — per ADR-0011 "big and fast for ingestion": every validate-code call delegated externally is a per-row round-trip cost the customer didn't agree to.
- **Compliance** — many payer customers operate in environments where outbound terminology API calls require legal review. Pure-local sidesteps the question.
- **Latency** — local UC Function calls inside Spark are negligible; tx.fhir.org adds 50-300ms per call, prohibitive at ingest scale.

**v1.x — configurable federation:** a `ronin_terminology_delegation` setting (`local-only` (default) | `federated-for-free-systems` | `federated-everywhere`) added in a follow-up ADR. Customers who explicitly want the broader-coverage trade can opt in then.

### 4. Storage schema — six Delta tables

```
ronin_<warehouse>.gold.terminology_codesystem_header
ronin_<warehouse>.gold.terminology_codesystem_concept
ronin_<warehouse>.gold.terminology_codesystem_property
ronin_<warehouse>.gold.terminology_valueset_definition
ronin_<warehouse>.gold.terminology_valueset_expansion
ronin_<warehouse>.gold.terminology_conceptmap
```

**Split rationale** (per Aidbox + Smile CDR + Snowstorm patterns): CodeSystem header and concepts split because the header is small metadata while concept tables can hold millions of rows (SNOMED CT US is ~360K concepts). Pre-materialize ValueSet expansions because read-side computation per call doesn't scale.

#### `terminology_codesystem_header` — small; one row per loaded CodeSystem version

```
system_url                     STRING NOT NULL    -- e.g., http://snomed.info/sct
system_version                 STRING NOT NULL    -- e.g., http://snomed.info/sct/731000124108/version/20260301
name                           STRING
title                          STRING
status                         STRING             -- draft | active | retired | unknown
content                        STRING             -- not-present | example | fragment | complete | supplement (per §7)
case_sensitive                 BOOLEAN
hierarchy_meaning              STRING             -- grouped-by | is-a | part-of | classified-with
compositional                  BOOLEAN
version_needed                 BOOLEAN
publisher                      STRING
date                           TIMESTAMP
count                          BIGINT             -- count of concepts (per CodeSystem.count)
loaded_at                      TIMESTAMP NOT NULL
loaded_from                    STRING             -- source URL or package canonical
ig_dependency                  ARRAY<STRING>      -- IG canonical URLs that pulled this CodeSystem in
```

No partitioning (small table; full-table scan is cheap).

#### `terminology_codesystem_concept` — large; one row per concept

```
system_url                     STRING NOT NULL
system_version                 STRING NOT NULL
code                           STRING NOT NULL
display                        STRING
definition                     STRING
designations                   ARRAY<STRUCT<language: STRING, use_system: STRING, use_code: STRING, value: STRING>>
properties                     ARRAY<STRUCT<code: STRING, value_string: STRING, value_code: STRING, value_decimal: DECIMAL(38,18), value_integer: BIGINT, value_boolean: BOOLEAN, value_datetime: TIMESTAMP, value_coding: STRUCT<system: STRING, code: STRING, display: STRING>>>
inactive                       BOOLEAN             -- per Ecosystem IG inactive-codes spec
status                         STRING              -- inactive | withdrawn | deprecated when inactive=true
loaded_at                      TIMESTAMP NOT NULL
```

Partition: `system_url`. Z-order: `code`. Point reads on `(system_url, system_version, code)` are partition-pruned and Z-order-narrowed; SNOMED CT US `$lookup` lands in single-digit ms on warm warehouse.

#### `terminology_codesystem_property` — separate; SNOMED hierarchy + LOINC parts + similar

```
system_url                     STRING NOT NULL
system_version                 STRING NOT NULL
source_code                    STRING NOT NULL
property_code                  STRING NOT NULL     -- parent | child | etc.
target_code                    STRING              -- for hierarchical / relational properties
target_system                  STRING              -- when cross-system reference
value_string                   STRING              -- for non-relational properties
```

Separate from `concept` so the concept rows stay narrow (hot path); the property table is queried on the `$subsumes`/`$closure` paths (v1.x). Partition: `system_url`.

#### `terminology_valueset_definition` — small; one row per ValueSet version

```
valueset_url                   STRING NOT NULL
valueset_version               STRING NOT NULL
name                           STRING
title                          STRING
status                         STRING
publisher                      STRING
date                           TIMESTAMP
compose_json                   STRING              -- ValueSet.compose body as JSON (intensional definition)
loaded_at                      TIMESTAMP NOT NULL
ig_dependency                  ARRAY<STRING>
```

`compose_json` keeps the original intensional rules verbatim — needed when an `$expand` request changes parameters (`activeOnly`, `displayLanguage`, `tx-resource`-passed CodeSystems) and the pre-materialized expansion isn't valid.

#### `terminology_valueset_expansion` — large; pre-materialized rows

```
valueset_url                   STRING NOT NULL
valueset_version               STRING NOT NULL
expansion_id                   STRING NOT NULL     -- per cluster B reproducibility
system_url                     STRING NOT NULL
system_version                 STRING
code                           STRING NOT NULL
display                        STRING
inactive                       BOOLEAN
designations                   ARRAY<STRUCT<language: STRING, value: STRING>>
expanded_at                    TIMESTAMP NOT NULL
expansion_parameters_json      STRING              -- the parameters used; needed to determine whether a different request needs re-expansion
```

Partition: `valueset_url`. Z-order: `(valueset_version, expansion_id)`. `$expand` is a partition scan filtered by version + expansion_id; payer-baseline US Core ValueSets are small (most under 1000 codes) so reads are sub-second on a 2X-Small warehouse.

#### `terminology_conceptmap` — bidirectional translation surface

```
conceptmap_url                 STRING NOT NULL
conceptmap_version             STRING NOT NULL
source_system                  STRING NOT NULL
source_code                    STRING NOT NULL
target_system                  STRING NOT NULL
target_code                    STRING
target_display                 STRING
equivalence                    STRING              -- equivalent | equal | wider | subsumes | narrower | specializes | inexact | unmatched | disjoint
comment                        STRING
group_source_version           STRING              -- ConceptMap.group.source.version
group_target_version           STRING              -- ConceptMap.group.target.version
loaded_at                      TIMESTAMP NOT NULL
ig_dependency                  ARRAY<STRING>
```

Partition: `source_system`. `$translate(source_system, source_code, conceptmap)` is a partition-pruned scan.

### 5. Binding pin — `silver.validation_provenance` (read-time terminology version recovery)

Historical-read terminology recovery is owned by a dedicated provenance table — resources don't carry binding pins inline.

```
ronin_<warehouse>.silver.validation_provenance

resource_type                  STRING NOT NULL
resource_id                    STRING NOT NULL
version_id                     BIGINT NOT NULL
fhir_version                   STRING NOT NULL
validated_at                   TIMESTAMP NOT NULL
validation_artifact_pin        STRING NOT NULL     -- foreign key to validation_artifacts (per ADR-0015 §7)
binding_pins                   ARRAY<STRUCT<
                                  binding_path: STRING,
                                  valueset_url: STRING,
                                  valueset_version: STRING,
                                  expansion_id: STRING,
                                  codesystem_pins: ARRAY<STRUCT<system_url: STRING, system_version: STRING>>
                                >>
```

**Why this shape:**

- Resource bodies stay pristine. No `meta.tag` bloat, no per-field extension noise. Reads from the canonical Gold tier are unchanged.
- Auditors and `_history` consumers join on `(resource_type, resource_id, version_id)` to recover binding state.
- The `binding_pins` array lets one row carry pins for every coded field on the resource (a Condition has Condition.code, Condition.severity, Condition.bodySite — each with its own ValueSet + expansion_id).
- The `validation_artifact_pin` foreign key chains back to ADR-0015 §7's pinning model — terminology + validation rules are recovered together, not independently.

Population: written at the Bronze→Silver→Gold validation step alongside the existing `audit_trail` STRUCT (per ADR-0010 Amendment 3).

Partition: `validated_at` year-month bucket (analogous to AuditEvent per ADR-0016).

### 6. Refresh choreography — `terminology_artifacts` pin + operator-flip activation

The refresh pattern mirrors ADR-0014's `ronin_ig_versions` ratchet: refresh Job materializes new versioned content; an explicit pin in a Delta table names the currently active version; flipping the pin is an atomic UC operation; operators control when the flip happens.

#### `terminology_artifacts` — the active-version pin table

```
ronin_<warehouse>.gold.terminology_artifacts

artifact_kind                  STRING NOT NULL     -- code_system | value_set | concept_map
canonical_url                  STRING NOT NULL
active_version                 STRING NOT NULL     -- the version row currently active in CapabilityStatement and validation reads
candidate_version              STRING              -- materialized but not active (waiting for operator activation)
activated_at                   TIMESTAMP NOT NULL
activated_by                   STRING              -- operator identity (UC principal)
prior_version                  STRING              -- previous active_version, for rollback
source                         STRING              -- ig_package | vsac | direct (loinc.org / NLM / etc.)
notes                          STRING
```

**Refresh flow:**

1. **Scheduled Job runs** at the cadence declared in ADR-0015 §10 (LOINC monthly, SNOMED CT US monthly with cluster B 30-day delay, RxNorm monthly, NDC weekly, ICD-10 annual, CVX ad-hoc, VSAC weekly).
2. **Job materializes** the new version into the gold.terminology_* tables. Both old and new versions coexist (the `system_version` / `valueset_version` columns differentiate).
3. **Job writes** the new version into `terminology_artifacts.candidate_version`, leaving `active_version` untouched.
4. **Operator inspects** the candidate via a `ronin terminology diff` command (compares row counts, deprecated codes, expansion deltas).
5. **Operator activates** via `ronin terminology activate <kind> <canonical_url> --version <v>` or the equivalent UC SQL operation. The activation flips `active_version` atomically; `prior_version` retains the rollback target.
6. **CapabilityStatement regeneration** (per ADR-0014 §2 Layer 2) reflects the new active version. Validators and SMART apps see the new content on their next discovery hit.

**Rollback:** `ronin terminology activate <kind> <canonical_url> --version <prior_version>` flips back; the prior content is still in `gold.terminology_*` because nothing was deleted.

**No auto-activation in v1.** Job material loads; operators decide when. Two reasons:

- Per cluster B SNOMED policy, NLM releases must be held 30 days before activation — auto-activation would break the policy.
- For payer customers operating under tightly governed change-management, terminology activation is a Change Record event; auto-activation removes the change-management hook.

**v1.x toggle** — a `ronin_terminology_auto_activate` deployment variable (default `false`) added in a follow-up ADR for customers who want hands-off operations.

### 7. THO + `content = not-present` handling

THO carries CodeSystem stubs for licensed externals. The Ecosystem IG forbids servers from processing `$expand` and `$validate-code` against `content = not-present` CodeSystems. The auto-provisioner and the validate-code UC Function jointly enforce:

1. **At THO load time:** the auto-provisioner walks `hl7.terminology` and inserts each CodeSystem into `terminology_codesystem_header` with its declared `content` value preserved verbatim. `content = not-present` rows enter the header table but no rows enter `terminology_codesystem_concept`.
2. **At `$validate-code` time:** the UC Function checks the header's `content` value first. If `content in (not-present, example)`, the function returns `result=false` + `x-caused-by-unknown-system: <system_url>` per Ecosystem IG. The caller (validator or SMART app) treats this as the cluster A lenient-warning path.
3. **When a licensed CodeSystem also loads** (e.g., the customer-provided SNOMED CT US load completes), the auto-provisioner replaces the stub header row — `content` becomes `complete` (or `fragment` if a partial license was loaded) and concept rows land in `terminology_codesystem_concept`. Subsequent `$validate-code` calls resolve normally.
4. **`content = fragment` handling:** per Ecosystem IG, validation returns an issue if the code isn't valid against the loaded fragment. Ronin's `$validate-code` matches this: returns `result=false` with a `processing-note` indicating fragment scope.
5. **`content = supplement` handling:** supplements augment an existing CodeSystem with additional designations or properties. The auto-provisioner merges supplement rows into the corresponding `concept` rows (per the Ecosystem IG language-pack pattern).

**Diagnostic surface:** `ronin terminology audit-coverage` (or the equivalent SQL) reports the count of `content = not-present` CodeSystem stubs in the active IGs + the count of those that have a licensed companion loaded. Customers preparing for production should reach 100% coverage on the externals they need to validate against; missing coverage degrades validation per cluster A.

### 8. Hot read path — Apps LRU cache + SQL warehouse warm pool

**Two-tier read path:**

- **Tier 1 — Apps-side LRU cache** (in the TS server process per ADR-0011 / ADR-0013). Warmed at startup with the small high-frequency ValueSets (US Core required bindings are nearly all under 1000 codes — administrative-gender, condition-clinical-status, encounter-status, etc.). Per the Ecosystem IG `cache-id` parameter: client passes the cache-id of its last-seen expansion; if Ronin's cache-id matches, return 304-equivalent (`Parameters` with `parameter: cache-id` and no body update). Drops network bytes by ~70% on hot paths.
- **Tier 2 — SQL warehouse warm pool.** For cache misses, large ValueSets, or ConceptMap lookups, the call lands on the SQL warehouse via the `ronin.terminology.*` UC Function family. Per ADR-0013, the warehouse is configured for always-on serverless to avoid cold-start latency on the first request after idle.

**Cache invalidation:** the Tier 1 LRU is keyed on `(valueset_url, valueset_version, expansion_id)`. Activation in §6 updates the active version → the cache key changes → next lookup misses and re-warms from the warehouse. No explicit invalidation push needed.

**Pre-warm policy at startup:** read every CapabilityStatement-asserted ValueSet whose count is below the configurable `ronin_terminology_prewarm_max_codes` threshold (default 5000). Large ValueSets (full SNOMED-derived sets) are NOT pre-warmed — too much memory for too little benefit, since SMART app traffic against full SNOMED sets is mostly cache-miss anyway.

### 9. Customer-facing REST surface

Ronin v1 exposes the FHIR Terminology Service endpoints required by the Ecosystem IG, mounted alongside the rest of the FHIR REST API on the TS server (per ADR-0011 / ADR-0013):

```
GET  /metadata?mode=terminology              -- TerminologyCapabilities resource
GET  /CodeSystem/{id}                        -- CodeSystem read
GET  /CodeSystem?url=...&version=...         -- CodeSystem search (url, version SHALL be supported per Ecosystem IG)
POST /CodeSystem/$validate-code              -- per ValueSet + per CodeSystem variants
POST /CodeSystem/$lookup
POST /CodeSystem/$subsumes                   -- v1.x: returns x-caused-by-unknown-system style operation-outcome
GET  /ValueSet/{id}
GET  /ValueSet?url=...&version=...           -- with _summary support per Ecosystem IG
POST /ValueSet/$expand
POST /ValueSet/$validate-code
GET  /ConceptMap/{id}
GET  /ConceptMap?source-system=...&target-system=...
POST /ConceptMap/$translate
```

**SMART scopes** (depend on ADR-0006 final shape; declared here as the candidate set):

- `user/CodeSystem.rs`, `user/ValueSet.rs`, `user/ConceptMap.rs` for the read + search interactions.
- Operations bind to the resource's scope (per FHIR REST conventions): `$validate-code` against ValueSet requires `user/ValueSet.rs`.
- Terminology reads do not carry PHI; per ADR-0016 §3.1 they fall under the application access log surface and do NOT generate AuditEvent (which is reserved for PHI-touching access).

**TerminologyCapabilities content** (per Ecosystem IG):

- `CapabilityStatement.instantiates = http://hl7.org/fhir/CapabilityStatement/terminology-server`
- All loaded CodeSystems listed in `TerminologyCapabilities.codeSystem` with their currently active `version`
- Supported parameters declared in `TerminologyCapabilities.expansion.parameter` (including `cache-id` and `tx-resource` flags)
- Supported `validateCode` mode declared per Ecosystem IG

### 10. Day-2 ops — cadences, drift, audit

**Refresh cadences** (ratified from ADR-0015 §10, no change):

| Source | Cadence | Notes |
|---|---|---|
| LOINC | Monthly | Direct from loinc.org |
| SNOMED CT US | Monthly with **30-day delay** (cluster B) | Direct from NLM (UMLS API key) |
| RxNorm | Monthly | Direct from NLM (UMLS API key) |
| NDC | Weekly | Direct from FDA |
| ICD-10-CM | Annual | Direct from CMS |
| CVX | Ad-hoc | Direct from CDC |
| HCPCS | Quarterly | Direct from CMS |
| CPT | Annual | Direct from AMA (paid license + AMA agreement) |
| VSAC ValueSets | Weekly | NLM VSAC FHIR API (UMLS key) |
| THO (`hl7.terminology`) | Per HL7 release (~quarterly) | Pulled via IG `package.json` dependency tree |
| IG-shipped ValueSets / CodeSystems | At IG-package activation per ADR-0014 §2 Layer 2 | No separate cadence |

**Drift detection:** the refresh Job emits a `terminology_refresh_run` row per execution (system + version found upstream + version currently active + delta summary). Operators query `ronin terminology drift` to see which systems have material pending. CI alarms can be wired against this signal.

**Audit posture:**

- **Provisioning operations** (loads, activations) write to `gold.terminology_artifacts` (§6) which is the audit surface for the terminology layer itself — `activated_by`, `activated_at`, `prior_version` are first-class columns.
- **Read operations** (`$validate-code`, `$expand`, `$lookup`, `$translate`) do NOT generate AuditEvent. Per ADR-0016 §3.1, AuditEvent is reserved for PHI-touching access. Terminology reads are PHI-free.
- **The Apps-side application access log** (per ADR-0016 §1 surface 2) DOES record terminology calls — request id, timing, status, cache hit/miss. Operators tune the warehouse pool sizing against this signal.

**License compliance audit** (per ADR-0014 cluster A):

- The auto-provisioner records the customer's declared `ronin_licensed_systems` at deploy time. Loads attempted against non-declared systems fail with a license-required error.
- Activations require an operator-confirmable license attestation (e.g., "I confirm this deployment is licensed for SNOMED CT US per [agreement]"). The attestation lands in `gold.installation_audit` (per ADR-0016 §5.2 follow-up).

## Consequences

**What this commits Ronin to** — the operational shape of the terminology layer is now fixed: six Delta tables in Gold, one binding-pin table in Silver, one artifacts pin table in Gold, two-tier read path (Apps LRU + warehouse). Customers see the operation surface in §2 and the REST endpoints in §9. The conformance commitment in §1 is what Marketplace listings, validator reports, and customer-side compliance documentation reference.

**What this enables downstream:**

- ADR-0015 §10's `ronin.terminology.validate_code` UC Function is now backed by a concrete schema; Layer A validation (per row, per coded field) has a documented call shape.
- Bronze→Silver Governance §B vocabulary normalization (per the governance research note) has a defined ConceptMap surface.
- The transformation engine POC's `ConceptMapRegistry` (per session 019 work) has a clear production target: an `assemble_bundle`-equivalent at ingest reads `terminology_conceptmap` directly from Gold.
- CMS-0057 Patient Access / Provider Access SMART apps get a conformant `/metadata?mode=terminology` response on first read — required for Inferno passes.
- Customer Day-2 ops have a documented refresh + activation flow with clear operator-control points.

**What it costs:**

- **Per-tenant Delta storage for terminology** — for a `payer_baseline` deployment with the full 13-IG matrix + SNOMED CT US + LOINC + RxNorm + ICD-10-CM + NDC, expansion + concept rows total ~5-15 GB compressed, depending on how many historic versions are retained. Small relative to FHIR data; documented in operability sizing.
- **Two-tier read complexity** — the Apps LRU cache adds a small invalidation responsibility on activation. Mitigated by keying on `(valueset_url, version, expansion_id)`.
- **Operator workflow** — activation is manual by design. Customers without dedicated terminology ops staff feel this cost. Mitigated by the v1.x auto-activation toggle.

## Alternatives considered

- **Federated lookup against tx.fhir.org for free systems.** Rejected for v1 per §3 — operational and latency cost outweighs coverage gain; v1.x configurable opt-in instead.
- **Stamp binding pins inline on resource bodies (`meta.tag` or per-field extension).** Rejected per §5 — bloats every resource; mixes data with metadata. The Silver provenance table keeps reads pristine.
- **Single denormalized `terminology` table with all kinds together.** Rejected — different access patterns per kind (concept-by-code point read; expansion partition scan; conceptmap source-system filter) want different partitions. Six tables make the partitioning trivial.
- **Auto-activate refresh runs.** Rejected for v1 per §6 — breaks cluster B SNOMED policy; removes the change-management hook payer customers rely on; v1.x toggle instead.
- **In-Apps full terminology service** (no warehouse fallback). Rejected — large CodeSystems don't fit memory; cluster-side hot-data cache is the right pattern; this matches ADR-0015's "run validation in TS REST server in-process — rejected" finding.
- **Generic content table with `kind` discriminator.** Rejected — same schema flaw as the single-table alternative; loses the partition pruning that makes hot reads cheap.

## Follow-up ADRs queued

- **`ronin_terminology_delegation` configurable federation** — v1.x knob for customers who explicitly want broader coverage at the cost of third-party dependency.
- **`ronin_terminology_auto_activate` toggle** — hands-off operations mode; default `false`; per §6.
- **`$subsumes` and `$closure`** — transitive-closure table design over CodeSystem hierarchy; first natural fit is SNOMED CT US.
- **AI-agent ConceptMap proposal queue** — agent surfaces unmapped codes from the transformation engine + Bronze→Silver step; analogous to MPI HITL per ADR-0012; v1.x.
- **License compliance audit table** (`gold.installation_audit` per ADR-0016 §5.2 follow-up) — extended with terminology activation attestations.
- **Terminology Marketplace listing** — Ronin's terminology surface as a standalone Marketplace product, per ADR-0014 cluster E + session-018 cluster E.

## Open questions not closed by this ADR

- **R5/R6 climb path for terminology.** Operations + resource shapes are stable across R4/R5/R6, but R5 added new ValueSet expansion parameters and R6 will likely add more. The `ronin_ig_versions` ratchet handles this generically; concrete R5 cutover details land in a future ADR closer to the climb.
- **Apps LRU cache sizing per deployment profile.** §8's `ronin_terminology_prewarm_max_codes = 5000` is a sensible default; per-deployment tuning belongs in the operability ADR.
- **CRMI (Canonical Resource Management Infrastructure) ShareableCodeSystem / ShareableValueSet conformance.** Ecosystem IG recommends but doesn't require. Ronin v1 doesn't claim CRMI conformance; revisit when a customer demands it.
- **Multi-tenant terminology sharing.** Two payer tenants on the same Ronin instance loading the same licensed SNOMED CT US — do they share storage? UC governance allows it; license terms may not. Belongs in a multi-tenancy ADR.

## Sources

- [Requirements for Servers — FHIR Terminology Ecosystem IG v1.9.1](https://build.fhir.org/ig/HL7/fhir-tx-ecosystem-ig/requirements.html)
- [Documentation — HL7 Terminology (THO) v7.2.0](https://build.fhir.org/ig/HL7/UTG/en/documentation.html)
- [THO Artifact Versioning Policy](https://confluence.hl7.org/spaces/TSMG/pages/175605503/HL7+Terminology+Artifact+Versioning+Policy)
- [Terminology Expectations for IG Developers](https://confluence.hl7.org/spaces/TSMG/pages/161063724/Terminology+Expectations+for+IG+Developers)
- [Terminology-service — FHIR v5.0.0](https://www.hl7.org/fhir/terminology-service.html)
- [Terminology Overview — Aidbox Docs](https://docs.aidbox.app/modules/terminology)
- [Two-Phase FHIR Terminology: Authoring & Usage — Health Samurai](https://www.health-samurai.io/articles/two-phase-fhir-terminology)
- [ValueSet Expansion — Smile CDR Documentation](https://smilecdr.com/docs/terminology/valueset_expansion.html)
- [Snowstorm — IHTSDO](https://github.com/IHTSDO/snowstorm)
- [FHIR Package Management — Health Samurai](https://www.health-samurai.io/articles/fhir-package-management)
