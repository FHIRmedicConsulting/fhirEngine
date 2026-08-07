# fhirEngine Code Quality and Architectural Gaps

> **RESOLVED 2026-08-05** — every module flagged below now has a dedicated unit suite
> (commits `4103914` + `7dd14c7`, 100 tests): `data-filter` (fail-closed scope→filter),
> `export-jobs` + `$export` route guards, `search-index`/`ingest` (choice-type dates,
> Period start+end), terminology `file-loaders` + `reconcile`, `jwks-auth`/`oidc-auth`,
> and `oauth/store`. Post-fix line coverage: 94–100% everywhere; `routes/export.ts`
> data paths are covered by the Delta integration suite. One correction: `data-filter.ts`
> lives in `src/auth/`, not `src/security/`.

While `fhirEngine` is a highly modern and well-architected FHIR R4 server (using Hono and Delta Lake), a deep dive into the repository reveals a few significant gaps, primarily revolving around **test coverage for mission-critical clinical and security modules**. 

You can provide this document directly to Claude or any other AI assistant as a blueprint for where to focus refactoring and testing efforts.

---

## 1. Zero-Coverage Data Filtering and Bulk Export
**Gap Location:** `src/routes/export.ts`, `src/lib/export-jobs.ts`, `src/security/data-filter.ts`

**The Issue:**
The FHIR Bulk Data Access (Export) API and Data Filtering pipelines have virtually 0% test coverage. 
- The `export-jobs.ts` file manages the async batch processing for large-scale data exports, which requires robust state-machine testing to prevent stuck jobs or memory leaks.
- `data-filter.ts` is responsible for redacting or filtering resources before they are returned to the client.

**Risk:**
A regression in `data-filter.ts` could lead to a massive HIPAA violation by exposing redacted data (e.g., in a multi-tenant environment or when a SMART app has restricted scopes).

**Suggestions for Claude:**
- Write comprehensive unit tests for `data-filter.ts` that pass mock FHIR resources (with both PHI and non-PHI fields) and verify that the output is properly redacted based on various scope rules.
- Add integration tests for `export.ts` to ensure that Bulk Data kickoff (`$export`), polling, and completion states behave correctly according to the SMART Bulk Data spec.

## 2. Unverified Search Index Construction
**Gap Location:** `src/repository/search-index.ts`, `src/repository/ingest.ts`

**The Issue:**
These files handle the construction of the "Bronze" row in Delta Lake, which includes parsing complex FHIR resources via `fhirpath` to build the search indices (`IdentifierIndexEntry` and `SearchIndexEntry`). Currently, both have 0% test coverage.

**Risk:**
FHIR search is notoriously complex due to nested elements and choice types (e.g., `[x]`). If `search-index.ts` incorrectly evaluates a FHIRPath expression, a resource will be written to Delta Lake without the correct indices. This results in silent data un-discoverability (e.g., a patient's condition exists but won't show up in a search). 

**Suggestions for Claude:**
- Create a unit test suite for `search-index.ts` that mocks a variety of complex FHIR resources (like a `Condition` with `onsetDateTime`, `onsetPeriod`, etc.).
- Ensure that the tests verify the output of `dateValues()` and `extractCodings()` logic so that ranges, prefixes, and exact matches are indexed accurately.

## 3. Untested Terminology Reconciliation
**Gap Location:** `src/terminology/file-loaders.ts`, `src/terminology/reconcile.ts`

**The Issue:**
Terminology services are the backbone of a FHIR engine's validation chain. The logic to parse, load, and reconcile ontologies (like SNOMED, LOINC, or RxNorm) from files into the Delta Lake warehouse is currently sitting at ~2-3% coverage.

**Risk:**
If terminology loaders fail silently or drop codes during an update, `Resource` validation will suddenly start rejecting valid clinical data because the `ValueSet` wasn't loaded properly.

**Suggestions for Claude:**
- Write unit tests for `file-loaders.ts` using mock terminology streams/files. 
- Implement tests for `reconcile.ts` to verify how the system handles terminology updates (e.g., overwriting vs. versioning codes) when the Delta table is updated.

## 4. OIDC and JWKS Auth Blind Spots
**Gap Location:** `src/auth/idp/jwks-auth.ts`, `src/auth/idp/oidc-auth.ts`, `src/auth/oauth/store.ts`

**The Issue:**
While the standard SMART/UDAP pipelines have good integration coverage, the lower-level identity provider (IDP) modules (specifically JWKS verification and OIDC token logic) lack unit tests (0% coverage).

**Risk:**
Security modules should always have 100% test coverage. A flaw in JWKS caching or signature verification could theoretically allow forged JWTs to bypass the auth gate.

**Suggestions for Claude:**
- Ask Claude to mock `jose` library responses and write unit tests verifying that expired tokens, improperly signed tokens, and missing claims correctly throw HTTP 401s in `jwks-auth.ts` and `oidc-auth.ts`.

---

## 5. No update-as-create (PUT to a nonexistent id → 404)
**Gap Location:** `src/repository/delta-resource-repository.ts` (`update()`), `src/routes/delta-resource.ts`

**The Issue:**
`update()` throws 404 when the id has never existed, so clients using deterministic
client-assigned ids (FHIR "Update as Create", spec-optional) cannot `PUT Type/{id}`
on first submission. Discovered 2026-08-06 wiring nemsis2fhir's Tier-1 harness.

**Workaround in use:**
Conditional update (`PUT Type?identifier=...`) works as a full upsert — 0 matches
creates via `create()`, which *does* preserve a client-supplied `resource.id`, so
literal references stay valid; 1 match updates in place. nemsis2fhir now stamps a
`urn:nemsis2fhir:resource-id` identifier on every resource and submits conditional
PUTs (Provenance, which has no identifier element in R4, matches on `?target=`).

**Suggestions for Claude:**
- Consider an opt-in `FHIRENGINE_UPDATE_AS_CREATE=true` allowing PUT-to-id to create
  (version 1) when the id has never existed, per R4 §3.1.0.4.2 — would let
  deterministic-id ETL clients skip the per-entry conditional search.

---

## 6. Terminology server fails the HL7 validator's tx approval battery
**Gap Location:** `src/routes/terminology.ts` (tx surface)

**The Issue:**
`validator_cli` (6.9.5) refuses fhirEngine as a `-tx` server: "The terminology
server ... is not approved for use with this software (it does not pass the
required tests)" (`TerminologyClientContext.checkFeature`). Recent validator
releases probe tx servers for conformance (tx-ecosystem test battery /
feature flags) before trusting them. Discovered 2026-08-06 wiring nemsis2fhir's
FML oracle.

**Workaround in use:**
`-authorise-non-conformant-tx-servers` — with it, fhirEngine works fine as the
validator's tx server (TerminologyCapabilities + $lookup/$validate-code answer;
transform output byte-identical to a tx.fhir.org run).

**What the gate actually checks (read from core 6.9.5 source, TerminologyClientContext.checkFeature):**
The CapabilityStatement must carry two "feature" extensions
(`http://hl7.org/fhir/uv/application-feature/StructureDefinition/feature`, sub-extensions
`definition` + `value`):
1. `definition = http://hl7.org/fhir/uv/tx-tests/FeatureDefinition/test-version`,
   `value` ≥ `1.6.0` — a CLAIM that the server passes that version of the HL7
   terminology test battery (current battery: v1.9.0).
2. `definition = http://hl7.org/fhir/uv/tx-ecosystem/FeatureDefinition/CodeSystemAsParameter`,
   `value = "true"` — the server accepts CodeSystem resources supplied inline in the
   `tx-resource` parameter of $validate-code/$expand.

**Baseline battery run (2026-08-06, `validator_cli txTests -tx <fhirEngine>`): 597/597 FAIL.**
Root causes, clustered:
- **No `tx-resource` parameter support** — the battery supplies its test
  CodeSystems/ValueSets inline per request; fhirEngine ignores them, so every
  expansion returns `total: 0` and every validation not-found. Implementing this
  (a request-scoped terminology overlay in $expand/$validate-code, plus the
  validator's `cache-id` contract) should flip the majority of the 597 — and it is
  the same capability the feature flag declares.
- **Missing system surface:** `GET /$versions` (404 today);
  `CapabilityStatement.instantiates` must include
  `http://hl7.org/fhir/CapabilityStatement/terminology-server`;
  `TerminologyCapabilities.expansion.parameter` must be declared.
- **Response-shape long tail:** exact Parameters echoes on $validate-code (expected
  6-7 parameters, fhirEngine returns 5), expansion structure fields, error
  OperationOutcome shapes, language/designation handling, filters
  (is-a/child-of/regex), supplements, inactive/deprecated semantics, batch
  validation, paging. The runner writes per-test `expected/` and `actual/` files —
  a ready-made TDD loop, suite by suite.

**Suggested sequence:** (1) tx-resource support → rerun battery; (2) $versions +
metadata declarations; (3) burn down remaining suites from the report diffs;
(4) only then declare the two feature extensions honestly (test-version = the
battery version that passes). Until then `-authorise-non-conformant-tx-servers`
is the sanctioned workaround.

**Progress (2026-08-06):**
- ✅ `GET|POST /$versions` implemented (validator's connect probe now detects
  "Server version 4.0.1 from $versions").
- ✅ `tx-resource` overlay implemented (`src/terminology/tx-resource-overlay.ts`):
  client-supplied CodeSystems/ValueSets evaluated in-memory for
  $validate-code/$expand/$lookup, with compose include/exclude/imports, filters
  (is-a, descendent-of, child-of, regex, =, in, not-in, exists),
  notSelectable→abstract / status→inactive flags, case-insensitive systems,
  count/offset paging, used-codesystem echoes, and `cache-id` sessions.
  `CodeSystemAsParameter` is now declared (honestly) in the CapabilityStatement;
  `test-version` remains deliberately undeclared until the battery passes.
- 📊 Battery after overlay: **91 of 597 passing (was 0/597)**; server survives
  the full run (circular-import cases guarded). Remaining failures by suite:
  version 202, validation 47, permutations 44, parameters 34, language 26+16,
  overload 25, notSelectable 16, extensions 11, deprecated 11, simple-cases 9.
- ⏳ Remaining: version-pinning semantics (system-version/check/force — the
  biggest bite), response-shape long tail (exact expansion/Parameters echoes,
  OperationOutcome message-id extensions, language/designation handling,
  supplements, batch) + `instantiates` terminology-server declaration +
  TerminologyCapabilities detail.

---

### Conclusion
The codebase is structurally sound and strictly typed, containing **zero `TODO`s or `FIXME`s**, which is impressive. However, the strict QA standards of a healthcare application necessitate that the modules above—especially those pertaining to data redaction and authentication—be prioritized for immediate unit test coverage.
