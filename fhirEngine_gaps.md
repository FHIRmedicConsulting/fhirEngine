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

### Conclusion
The codebase is structurally sound and strictly typed, containing **zero `TODO`s or `FIXME`s**, which is impressive. However, the strict QA standards of a healthcare application necessitate that the modules above—especially those pertaining to data redaction and authentication—be prioritized for immediate unit test coverage.
