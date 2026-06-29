# ADR-0005: Search Execution Model — Hybrid Patient-Compartment + Layer 4c Search-Index + Direct Projection Scan, Three-Tier Parameter Coverage, Post-Filter `Bundle.total`

- Status: **Accepted**
- Date: 2026-06-20
- Decider(s): Chad
- Session: 019
- Related: [ADR-0006](0006-smart-on-fhir-and-udap-security.md) §5 (scope enforcement), [ADR-0010](0010-storage-shape.md) §4 (Patient compartment + projections), [ADR-0011](0011-write-contract.md) (CDF triggers), [ADR-0014](0014-conformance-targets-and-ig-matrix.md) (US Core search parameters), [ADR-0015](0015-validation-architecture.md) Amendment 2 (denormalized security columns), [ADR-0017](0017-terminology-service.md) §8 (warm warehouse pattern), [ADR-0018](0018-patient-portal-consent-and-read-time-filter.md) §5 (read-time filter)

## Context

The FHIR REST search surface — `GET /Observation?patient=X&category=lab&date=gt2026-01-01&_sort=-date&_count=20` — is the dominant read pattern for CMS-0057-required APIs and SMART-on-FHIR apps. ADR-0010 covered point reads by `fhir_id`, identifier lookups via `gold.identifier_index`, Patient compartment for "give me everything about patient X," and Bulk Data NDJSON for population exports. What's left uncovered is *arbitrary search-parameter queries* — the bulk of REST traffic.

Without an ADR locking the execution model, three concrete risks materialize:

1. Implementation drift between TS-server-side (interactive read) and Python-side (analytics-style queries) — per ADR-0011 the two paths share a write contract; without a corresponding read contract, search semantics drift.
2. Inability to commit to performance targets in customer-facing collateral; Patient Access SMART apps need a p95 latency floor that locks today.
3. Capability-statement noise — partial / inconsistent search-parameter support across resource types makes the CapabilityStatement misleading and Inferno tests fail unpredictably.

The model commits to architectural shape and v1 coverage. Concrete index tuning + per-deployment parameter materialization configurations belong in ADR-0019 + ADR-0021 operations layers.

## Decision

### 1. Search execution architecture — hybrid

Three execution paths, selected by query shape, all served from the warm SQL warehouse + Apps-side query planner:

| Query shape | Execution path | Backing storage |
|---|---|---|
| **Patient-bound** (`?patient=X&...`) | Layer 4a Patient compartment scan | `gold.patient_compartment_<resource_type>` (per ADR-0010 §4) |
| **Common population** (high-traffic search parameters per active deployment profile) | Layer 4c search-parameter-indexed projection | `gold.search_index_<resource_type>_<param>` (new — see §1.1) |
| **Ad-hoc / rare population** | Direct `*_current` scan with partition pruning + ZORDER | `gold.<resource_type>_r4_current` (per ADR-0010 §4) |

The Apps-side parser inspects the parsed search query:

```
1. Parse search query → canonical AST with parameter list.
2. Check: does the query bind to a patient? (presence of `?patient=` or session has `launch/patient` + `patient/X.rs` scope)
   YES → route to compartment.
3. Else: check each parameter against the active deployment's Layer 4c materialization list.
   All searched params materialized → route to Layer 4c with multi-parameter join.
   Some materialized, some not → hybrid join (4c for materialized; direct scan for residuals).
4. Else: route to direct `*_current` scan.
```

The router writes to `gold.observability.app_request_log` (per ADR-0021 §10) which path served each query — operators tune Layer 4c materialization based on observed routing.

#### 1.1 Layer 4c — search-parameter-indexed projections

```
ronin_<warehouse>.gold.search_index_<resource_type>_<param>

resource_type        STRING NOT NULL    -- redundant but available for cross-type unions
fhir_id              STRING NOT NULL
patient_id           STRING             -- nullable (resources outside Patient compartment)
param_value          STRING             -- canonical-form value (per FHIR R4 search-param value canonicalization)
param_value_token    STRING             -- token form (for token-typed params with system+code)
param_value_date     TIMESTAMP          -- date form (for date-typed params; nullable)
param_value_quantity DOUBLE             -- quantity form (for quantity-typed params; nullable + comparator column)
param_comparator     STRING             -- eq / ne / lt / gt / le / ge / ap (for date + quantity)
last_updated         TIMESTAMP NOT NULL
confidentiality_level STRING            -- denormalized per ADR-0015 Amendment 2 §A2.2 for filter pushdown
sensitivity_tags     ARRAY<STRING>      -- same
```

Partition: `resource_type` + year-month bucket of `last_updated`. ZORDER: `(param_value, fhir_id)`. Per-parameter table per resource type — small fan-out for common parameters (US Core's required + must-support sets); customers opt into additional materializations via `ronin_search_materialized_params` (per-resource-type list).

Populated via Spark Structured Streaming reading from `*_current` CDF (per ADR-0011); writes happen as part of the Silver→Gold blessing DLT pipeline (per ADR-0019 §5).

#### 1.2 Patient compartment query semantics

Patient-bound search inside the compartment runs as a partition-pruned scan + parameter predicate against the per-patient slice:

```sql
SELECT *
FROM gold.patient_compartment_observation
WHERE patient_id = '<patient_fhir_id>'
  AND <search-parameter predicates>
ORDER BY <sort_key>
LIMIT <_count>
OFFSET <continuation_token_offset>
```

Patient compartment is small per-patient (10-50K rows for a typical encounter-rich patient over multi-year history); ZORDER on `(category, code, effectiveDateTime)` for Observation; analogous per-resource-type ZORDER strategies covered in ADR-0019 §3.

### 2. Search parameter coverage scope — three tiers

**Must support in v1** (CapabilityStatement asserts support; Inferno tests pass per ADR-0014 §7 + ADR-0020 §2):

- All US Core 6.1.0 required search parameters per resource type.
- All FHIR R4 base required search parameters per resource type.
- Universal: `_id`, `_lastUpdated`, `_tag`, `_security`, `_profile`.
- Token-modifier support: `:not`, `:above`, `:below`, `:in`, `:not-in` per FHIR R4.
- Date-modifier support: `lt`, `gt`, `le`, `ge`, `eq`, `ne`, `ap` (approximate).
- String-modifier support: `:contains`, `:exact`, `:missing`.
- Reference-modifier support: `:[type]` (typed reference filter).

**Defer to v1.x** (CapabilityStatement asserts `searchParam.extension` as `not-supported` with the canonical extension URL):

- **Chained search** (`?subject:Patient.name=Smith`) — requires multi-table joins per chain segment; not a CMS-0057 requirement.
- **Reverse-chained `_has`** (`?_has:Observation:patient:code=X`) — same.
- **Composite search parameters** (`?code-value-quantity=...`) — defer until customer demand surfaces; not US Core required.
- **Custom search parameters** (customer-defined SearchParameter resources) — defer to v1.x; v1 ships with the catalog set only.
- **`_query`** (named queries) — defer.
- **`_text` / `_content`** (full-text search against resource narrative / content) — defer; requires a separate full-text index path not yet sized.

**Out of v1 entirely:**

- **GraphQL endpoint** — separate REST surface; v2+ candidate.
- **FHIRPath-as-search** — non-standard; not on the CMS-0057 floor.

### 3. Result parameter scope — must / defer

**Must support in v1:**

- `_summary` (`true` | `false` | `text` | `count` | `data`).
- `_elements` (comma-separated field projection).
- `_count` (per-page result count; default 20; max 1000).
- `_sort` (single + multi-key; ascending / descending via `-` prefix).
- `_include` (per §4).
- `_revinclude` (per §4).
- `_total` (`none` | `estimate` | `accurate` per §5).

**Defer to v1.x:**

- `_contained` / `_containedType` — relevant for some specialized profiles; minimal CMS-0057 traffic.
- `_has` reverse-chained — covered in §2 deferral.

### 4. `_include` / `_revinclude` execution + caps

Execution is a **second SQL pass** against the same projection layer:

1. Primary query returns the result set (per §1's routing).
2. Parser walks `_include` / `_revinclude` declarations; collects target references from the result set.
3. Second pass: SELECT against the referenced resources' `*_current` tables; same Consent gate (per §8) applies; included resources land in the same Bundle.

**Caps:**

- Per-include cap: 100 referenced resources per resource type.
- Multiple `_include` declarations sum: total cap 500 included resources per request.
- Configurable via `ronin_search_include_cap` (per-resource-type) and `ronin_search_include_total_cap` (per-request).
- Over-cap: included resources truncated; `Bundle.entry[].search.mode = include` with `OperationOutcome` warning indicating truncation.

**Common patterns optimized:**

- `_include=Observation:subject` (pull Patient context) — common; default include cap suffices.
- `_revinclude=Provenance:target` (pull Provenance per ADR-0012 §8) — common; ensure Provenance partition is well-aligned.

### 5. `Bundle.total` computation — estimate by default

Per FHIR R4 spec, the `_total` parameter controls how `Bundle.total` is computed:

| `_total` value | Behavior |
|---|---|
| `none` | No `Bundle.total`; client uses `Bundle.link.next` to paginate |
| `estimate` (**default**) | Approximate count via Delta statistics + sample-based estimation |
| `accurate` | Exact count via `SELECT COUNT(*)` against the same query plan |

Default is `estimate` because exact counts at scale (10M-member-payer; multi-billion-row resource tables) are expensive enough to threaten the §7 patient-bound p95 < 500ms target. Clients that need exact totals (auditors, analytics tooling) opt in to `_total=accurate`.

Estimate accuracy: Delta's `DESCRIBE DETAIL` + per-partition row count + (when needed) `TABLESAMPLE` against the predicate-restricted partition; error typically ±10% for queries crossing > 100K rows.

### 6. Population-search rate limiting

A customer's analytics workload can starve Patient Access SMART app traffic if it issues high-frequency population queries. The router applies per-deployment QPS limits:

```
ronin_search_population_qps_limit (default 10)
```

- **Patient-bound queries** (containing `?patient=` or driven by `launch/patient` + `patient/X.rs`) are NOT counted against the limit.
- **Population queries** in excess of the limit return `429 Too Many Requests` with `Retry-After` header indicating when the next slot opens.
- Per-deployment override: `payer_baseline` may raise to handle Provider Access bulk patterns; `strict_federal` may lower for cost predictability.
- Rate limit is per-client (token-introspected subject); not per-IP.

The OAuth event log (per ADR-0016 §1 surface 3) captures `rate_limited` events; operators tune the limit based on the customer's actual workload mix.

### 7. Performance posture — v1 targets

| Path | p50 target | p95 target |
|---|---|---|
| Patient-bound query against warm Patient compartment | < 200 ms | **< 500 ms** |
| Patient compartment cold start (first access for the patient) | < 1 s | **< 2 s** |
| Common population query (all params materialized in Layer 4c) | < 1 s | < 3 s |
| Ad-hoc population query (direct `*_current` scan) | < 3 s | **< 10 s** |
| `_include` second pass | adds 100-500 ms | adds 1 s |

**Bulk-Data `$export`** remains the path for population-scale analytics. Search targets above assume bounded result sets (`_count <= 1000`); larger result sets degrade outside the targets but use `$export`.

Targets are commitments for `payer_baseline` per ADR-0019 §6 cluster sizing. `provider_baseline` may run smaller clusters and miss targets at peak; documented in operability runbooks (per ADR-0021 §6).

### 8. Consent filter integration with search

Ratifies how ADR-0018 §5's row-level Consent gate integrates with search:

- Gate applies per-result-row as the SQL predicate set is assembled. Excluded rows never reach the response Bundle.
- `_include` / `_revinclude` results pass through the same gate (the consent gate runs against included resources too).
- `Bundle.total` is **post-filter** when `_total=accurate`: count after the gate; client sees consistent counts that don't leak excluded-resource existence. When `_total=estimate`, the estimate reflects the post-filter sample.
- `OperationOutcome` warning attached to the Bundle when any resources were excluded by the Consent gate; warning describes redaction categories without per-resource enumeration (matches ADR-0018 §5.4 + ADR-0021 §7 `$everything` pattern).

### 9. Mechanical FHIR-spec decisions (no live trade)

- **Paging**: `Bundle.link.next` with an opaque continuation token. Token encodes `(query_hash, offset, sort_state)`; stateless server-side (no cursor table). Per FHIR R4 conventions.
- **Sort**: default `_sort=-_lastUpdated` when no explicit sort given; per-resource-type sensible defaults overridable via `ronin_search_default_sort_<resource_type>`. Multi-key sort supported (`_sort=-date,_id`).
- **`_profile` / `_tag` / `_security`**: implemented via the denormalized columns from ADR-0015 Amendment 2 §A2.2 (`confidentiality_level`, `sensitivity_tags`, `policy_tags`) — partition-prune-friendly; same cost shape as resource-type-required parameters.
- **Bundle metadata**: `Bundle.type = searchset`; `Bundle.timestamp` = server response time; `Bundle.link.self` = the canonical URL of the search; `Bundle.link.next` if pagination continues.
- **CapabilityStatement**: per ADR-0014 §10, lists supported searchParam + interaction = search for each resource type per the §2 coverage tier. Deferred parameters surface as `not-supported` with the canonical capability extension.
- **Error responses**: invalid search params → `400 Bad Request` + `OperationOutcome` per FHIR R4. Unparseable search expressions → 400. Authorization failures → 403. Compartment-bound query without `launch/patient` context → 400 + clear message.

## Consequences

**What this commits Ronin to:**

- A new tier of Delta tables (`gold.search_index_<resource_type>_<param>`) — adds storage cost proportional to materialized parameter count.
- Apps-side query parser is now non-trivial — parses FHIR search syntax, canonicalizes parameters, routes per §1, generates Spark SQL. Implementation lands in the TS server tier per ADR-0011.
- Patient compartment becomes a load-bearing fast path — patient-bound performance targets depend on its materialization staying current; ADR-0010 §4 sync semantics are now performance-critical (not just functionally critical).
- Layer 4c materialization is customer-tunable — operators decide which parameters to materialize per resource type via `ronin_search_materialized_params`; default v1 ships materializations covering US Core required parameter sets.
- Population-query rate limiting changes the operator contract — customer analytics workloads need explicit budget allocation via `ronin_search_population_qps_limit`.

**What it enables downstream:**

- CapabilityStatement (per ADR-0014 §10) can now declare concrete searchParam support per resource type.
- Inferno SMART App Launch + PDex + Bulk Data test kits (per ADR-0020 §2) have a clear search execution model to validate against.
- Patient Access SMART apps get a published p95 < 500ms commitment in customer-facing collateral.
- Provider Access bulk patterns get a clear performance trade — materialize the parameters they use, accept ad-hoc query degradation otherwise.
- Operations tuning per ADR-0019 has a concrete observability surface (which path served each query; which parameters are unmaterialized).

**What it costs:**

- Layer 4c write cost: 5-20% additional Bronze→Silver→Gold compute depending on materialized parameter count.
- Layer 4c storage: per-payer-deployment, materialized indexes add ~10-20% to the medallion footprint per ADR-0019 §4.
- Apps-side parser implementation complexity: every search-parameter type (string, token, date, reference, quantity, composite) needs its own canonicalization path.
- Bundle.total post-filter accuracy depends on Consent gate stability; ADR-0018 §5 cache decisions affect total computation cost.

## Alternatives considered

- **Indexed-column approach (HAPI/Aidbox `spidx_*`)**. Rejected as the *default* execution path — fast at small scale but write cost compounds badly at 10M-member-payer scale. Layer 4c materialization captures the *useful* subset of this pattern.
- **SQL-on-FHIR ViewDefinitions** (Pathling pattern). Rejected as the v1 default — customer-extensible but adds a new conceptual layer for operators to manage; v2+ candidate as a more flexible alternative to Layer 4c materializations.
- **Direct projection scan everywhere** (no Layer 4c). Rejected — works for ad-hoc but misses the §7 patient-bound performance target at scale; Patient compartment + Layer 4c carry the high-traffic load.
- **Materialize all US Core search parameters by default for every resource type**. Rejected as too costly — `payer_baseline` default ships the high-value subset; customers opt in to more via `ronin_search_materialized_params`.
- **Exact `Bundle.total` by default**. Rejected per §5 — exact counts at scale threaten the patient-bound performance target; `_total=accurate` opt-in serves auditors / analytics.
- **Pre-filter `Bundle.total`** (leak count of excluded-by-Consent resources). Rejected per §8 — leaks existence of redacted resources; inconsistent with ADR-0018 data-segmentation principle.
- **Per-IP rate limiting** instead of per-subject. Rejected per §6 — multi-app tenants share IP space; subject-keyed enforcement is the right granularity.

## Follow-up ADRs queued

- **ADR-0005 Amendment: chained search support** (v1.x) — implementation pattern + performance posture for `?subject:Patient.name=Smith` etc.
- **`_has` reverse-chained search** (v1.x) — additional join layer; performance commitments.
- **Custom SearchParameter resources** (v1.x) — customer-defined search parameters; index generation per parameter.
- **SQL-on-FHIR ViewDefinitions** (v2+) — flexible alternative to Layer 4c materializations.
- **GraphQL endpoint** (v2+) — separate REST surface; specific spec compliance.
- **Full-text search** (`_text` / `_content`) (v2+) — requires separate index path; Spark NLP or external full-text engine evaluation.

## Open questions not closed by this ADR

- **Layer 4c materialization default set per deployment profile** — `payer_baseline` ships covering US Core required parameters; concrete per-resource-type defaults belong in the operability research notes once the validation throughput POC unblocks.
- **Continuation token encryption** — opaque token encodes query state; should it be HMAC-signed or encrypted to prevent client tampering? Defaults to HMAC-signed; encryption is a §9 follow-up.
- **Search across resource types** (`GET /` with `?_type=Observation,Condition`) — FHIR R4 supports cross-resource-type search at the root; not commonly used. Defer to v1.x; CapabilityStatement asserts `not-supported` initially.
- **`_sort` by computed expression** — FHIR R5 added `_sort=expression(<FHIRPath>)`; v2+ when Ronin climbs to R5.
- **Search result Bundle assembly performance** — large `_include` chains can require multiple second passes; sub-second targets may need shape refinement.
- **`patient/$everything` vs. `Patient/{id}/$everything`** — operation-level pattern overlaps with patient-bound search; routing semantics in ADR-0021 §7 cover `$everything`; consistency with §1 routing here is worth documenting in operability.

## Sources

- [FHIR R4 Search](https://hl7.org/fhir/R4/search.html) — operation spec
- [FHIR R4 SearchParameter Registry](https://hl7.org/fhir/R4/searchparameter-registry.html) — required parameters per resource type
- [US Core 6.1.0 Search Parameters](https://hl7.org/fhir/us/core/STU6.1/conformance.html) — required + must-support sets
- [HAPI FHIR — Indexing and Searches](https://hapifhir.io/hapi-fhir/docs/server_jpa/search.html) — `spidx_*` pattern reference
- [Aidbox — Search](https://docs.aidbox.app/api-1/fhir-api/search-1) — search execution patterns
- [Pathling — Materialized Views](https://pathling.csiro.au/docs/server/operations) — SQL-on-FHIR ViewDefinitions
- [SQL on FHIR v2](https://sql-on-fhir.org/) — view definition spec
- ADR-0010 §4 — Patient compartment + projection layer that §1 routes against
- ADR-0011 — CDF triggers that populate Layer 4c
- ADR-0015 Amendment 2 §A2.2 — denormalized columns that §9 `_profile` / `_tag` / `_security` use
- ADR-0017 §8 — warm warehouse pattern that the SQL execution rides on
- ADR-0018 §5 — Consent gate integrated in §8
- ADR-0019 §5 + §6 — DLT pipeline + cluster sizing that materializes Layer 4c
- ADR-0021 §10 — observability tables that surface routing telemetry
