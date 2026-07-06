# Changelog

All notable changes to fhirEngine are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/) and is **pre-alpha** (`0.x` — anything may change).

## [Unreleased]

### Changed / fixed (feature-completeness follow-ups)
- **`Patient/$everything` now paginates and honors `_since`.** It previously returned the entire
  compartment in one unbounded Bundle and ignored `_since`. Now `_count`/`_getpagesoffset` page a
  deterministically-ordered result with a `next` link, and `_since` filters by `meta.lastUpdated`.
- **System `_history` no longer fans out across 146 tables in Node.** It ran one query per resource
  type, pulled `offset+count` rows from every table into memory, and JS-sorted per request. It's now
  a single DataFusion `UNION ALL … ORDER BY last_updated DESC, id DESC LIMIT/OFFSET` — the engine
  sorts and pages; `total` is one `count(*)`.
- **Validation now rejects unknown/extra elements** (structural validator) — a resource with a
  garbage or **typo'd** element (e.g. `deceasedBolean` for `deceasedBoolean`, `valueStrng` for
  `valueString`) was previously accepted silently; it's now a 422. FHIR base elements the
  columnar schema drops (meta/text/extension/contained/modifierExtension) and primitive-extension
  `_field` siblings are allowlisted so valid US Core resources still pass. (Max-cardinality for
  finite `max=N` is still not enforced — the columnar schema only carries list-vs-scalar; deferred.)
- **PAS `Claim/$submit` returns a PENDED response, not an approval.** It previously returned
  `outcome: complete` + a fabricated `preAuthRef`, which a partner's integration engine would
  machine-read as an authorization. It now returns `outcome: queued` with a Da Vinci review-action
  of `pended` and NO `preAuthRef` (a tracking identifier only) — fhirEngine performs no
  adjudication, and the response can no longer be misread as a grant. (`$inquire` correlates by
  the tracking id.)
- Removed a phantom `EobRepository.c4bbProfileForType()` reference and corrected stale
  CapabilityStatement docstrings (from the feature-completeness audit).

## [0.1.0-alpha.4] - 2026-07-05

### Security (deep-audit hardening, 2026-07-05)
Findings from a full code-quality + vulnerability audit (4 specialist review passes + adversarial
verification). Access-control fixes apply when auth is enabled (the PHI posture):
- **Bulk `$export`/`$everything` and system `_history` are now scope-gated.** The auth middleware
  only enforced scopes on capitalized resource paths, so operation/underscore endpoints reached
  their handlers with merely a valid token; `$export` had no authz at all and `_history`'s guard
  fell open. `buildDataFilter` now **fails closed**; system/group `$export` requires a system read
  scope (a patient-context token cannot dump the population); a patient-scoped `Patient/$export` is
  constrained to the caller's compartment.
- **Cross-compartment writes blocked.** PUT/DELETE and conditional PUT/DELETE were not
  compartment-gated — a patient-scoped write token could modify another patient's records. All
  write paths now run the compartment guard.
- **Bulk-export file routes hardened against path traversal.** `jobId`/`type` are validated before
  touching the filesystem — a `..`-laden id could previously read arbitrary `.ndjson`/`manifest.json`
  or recursively delete arbitrary directories.
- **Sidecar hardening.** Optional shared-secret gate (`FHIRENGINE_SIDECAR_TOKEN`) on the
  otherwise-unauthenticated storage sidecar (a full-PHI, destructive API); `..`-traversal +
  object-store-exfil rejection on caller-supplied table paths; a request-body size cap; and merge
  `key` identifier validation.

Audit-backlog batch (2026-07-05):
- **id-tokens rejected on the resource API** — a scopeless token (an OIDC id_token carries no
  scope and targets the client, not this server) now 401s before it can act as an access token.
- **Purpose-of-Use is sourced from a verified token claim**, never the client `X-Purpose-Of-Use`
  header, which could otherwise unlock consent-gated data.
- **`_include`/`_revinclude` entries and `_history` bodies are consent-gated/obligation-redacted** —
  includes are fetched by direct read and previously bypassed the compartment + consent filters.
- **SSRF guard on UDAP CRL/OCSP fetches** — cert-supplied CDP/AIA URLs can no longer target
  loopback/RFC1918/link-local/cloud-metadata addresses.

### Fixed (correctness, from the audit)
- **MPI reference rewrite corrupted unrelated patients.** `Patient/<merged>` rewriting used raw
  substring replace, so merging `Patient/123` also rewrote `Patient/1234` (a different patient) and
  mutated free-text. Now a structured walk rewrites only exact `reference` id-tokens.
- **POST with an existing id broke the single-`is_current` invariant** (two current rows + silent
  lost write) → now a 409 (use PUT to update).
- **Unstable pagination** — search `ORDER BY` had no unique tiebreaker (ties could duplicate/skip
  rows across pages); added `, id`.
- **Token comma-OR ignored** — `status=active,completed` matched nothing; now an `IN(...)` OR.
- **MPI survivor chains were iteration-order-dependent** — `loadSurvivorMap` now path-compresses
  A→B→C to the terminal survivor.
- **Cross-process write-version conflict is detected, not silently dropped** — two server instances
  computing the same next version off a stale read now surface a conflict (guarded MERGE +
  insert-count check) instead of one write vanishing.
- **Conditional create (If-None-Exist) is atomic** — the match-check + create run in one per-table
  critical section, so concurrent conditional creates can't both insert a duplicate identifier.

### Changed / removed
- Dropped the dead `InMemoryWarehouse` (~440 lines) and the sidecar's unused validation apparatus,
  removing the heavy `fhir.resources` (pydantic) dependency from the sidecar image.
- Shared `logSwallowed` helper surfaces previously-invisible swallowed faults; duplicated
  `OperationOutcome` builders consolidated into `lib/errors.operationOutcome`.

## [0.1.0-alpha.3] - 2026-07-04

### Security
- **JWT algorithm allow-lists pinned at verify time** on all four verification sites
  (JWKS/OIDC gate, `local` strategy, RFC 9101 signed request objects, Backend-Services
  client assertions) — closes deep-dive item A5. `FHIRENGINE_JWT_ALG` pins a single
  algorithm for the gate; defaults are asymmetric-only (`ES256/ES384/RS256/PS256`; the
  OAuth server accepts its advertised `RS256/ES384`).
- **SQL-injection regression suite** (`delta-search-injection.test.ts`) — hostile search
  values/param codes/range values execute as bound parameters, never as SQL (deep-dive D3).

### Added
- **`docs/compliance/security-posture.md`** — OSS-worded HIPAA §164.312 crosswalk, FIPS
  140-3 "document-don't-claim" posture, supply-chain summary, and the honest operator/
  organizational responsibility split (replaces the never-ported Databricks-worded
  heritage doc; deep-dive roadmap item 11). The 2026-07-03 security deep-dive gains an
  implementation-status addendum mapping every roadmap item to its ADR/patch.

## [0.1.0-alpha.2] - 2026-07-04

### Added
- **Medallion serving (Bronze/Silver/Gold complete)** — `FHIRENGINE_STORAGE_MODE=medallion`
  now works end-to-end: the API **ingests to Bronze** (write domain: version chain,
  optimistic locking, conditional-write uniqueness, history/vread) and **serves
  current-state reads + searches from Gold** (same row shape as Bronze, so the whole
  search engine runs unchanged). Promotion is **external by design** (Dagster / Databricks /
  cron): `fhirengine-promote <Type…>|--all` (`npm run promote`) is the idempotent
  full-rebuild reference promoter, and Bronze/Silver tables are created with
  `delta.enableChangeDataFeed=true` so external promoters can consume incremental
  changes (ADR-0026, now Accepted). Eventual consistency in medallion is by design —
  a just-ingested resource serves 404 until promoted; single-store (default) keeps
  read-after-write. Gold tables an external promoter writes appear without a server
  restart (probe-on-miss discovery).

- **MPI / dedup enforced in Silver + Gold** (ADR-0012 v1, deterministic) — promotion now
  resolves Patient identity: duplicates sharing a normalized business identifier
  auto-merge (survivor = latest write; merged record stays readable by id with a
  `replaced-by` link + `active=false` but is excluded from every search; the survivor
  absorbs the merged identifiers so old MRNs resolve to the golden record), and
  `Patient/<merged>` references in every other promoted type are rewritten to the
  survivor. Hard-deny guardrails (§3.4 — conflicting SSN = hard distinct, sex mismatch,
  date-of-death mismatch, multi-match ≥3) never auto-merge: they land in the
  `patient_match_review` stewardship queue. `patient_link` (authoritative identifier→id
  map) + `patient_merge_history` + merge `Provenance` (activity=MERGE) are maintained —
  all Gold-anchored per the ADR. `FHIRENGINE_MPI=off` disables; Splink/PPRL stay
  external-pipeline scope.

### Fixed
- `promote()` did not carry `search_param_index`/`is_current` into Gold rows (searches
  over Gold silently returned nothing) and Silver re-promotion failed on inferred-schema
  drift (`overwrite` now replaces the schema — full-rebuild is idempotent).

## [0.1.0-alpha.1] - 2026-07-04

### Added
- **FHIR R4 REST surface** — CRUD, history (instance/type/system), vread, CapabilityStatement,
  `$validate`, `$everything`, `$export` (async), batch/transaction, conditional create/update/delete,
  and rich search (token/string/date/number/quantity/uri/reference incl. bare-id, modifiers, chaining,
  `_has`, `_include`/`_revinclude` incl. `:iterate`, `_sort`/`_summary`/`_elements`, paging, POST `_search`).
- **Validation prior to Bronze** — structural + cardinality + choice-type + terminology bindings
  (3-state) + L4 FHIRPath invariants (top-level/one-level, R4-model-aware) + installed-profile
  required elements/bindings + slicing (first cut).
- **Terminology server** — local `$validate-code` / `$expand` / `$lookup` + `TerminologyCapabilities`;
  IG install + operator-supplied SNOMED/LOINC/RxNorm loaders + VSAC pull-once.
- **Security infrastructure** (ADR-0031..0036) — hardened TLS (NIST SP 800-52r2, cert hot-reload),
  fail-closed **production security profile**, HTTP hardening (security headers, enforced CORS,
  pluggable rate limiting, body limits), **tamper-evident (hash-chained) audit** + `fhirengine-audit-verify`,
  SMART auth server + Backend Services + **UDAP B2B trust foundation**, and SBOM + npm-audit +
  pip-audit + gitleaks + Trivy in CI.
- **UDAP B2B trust (hardened)** — RFC 5280 cert-path validation (basic constraints, key usage,
  **name constraints**), revocation via static list + live **CRL** + **OCSP**, a durable registered-client
  registry, `signed_metadata`, and tiered OAuth (RFC 9101 signed request).
- **CMS-0057 B2B APIs (FHIR-facing first slices)** — Da Vinci **PAS** (`Claim/$submit` +
  `Claim/$inquire`, records/returns a `ClaimResponse` with `preAuthRef`), **CRD** via CDS Hooks
  (`/cds-services` discovery + `coverage-requirements` service), **DTR**
  (`Questionnaire/$questionnaire-package`, packages a form + its cqf-library Libraries / answerValueSet
  ValueSets), **HRex** `Patient/$member-match`, **Patient Access** CARIN BB/PDex `ExplanationOfBenefit`
  surface (R4 + patient-compartment + CARIN `type`/`service-date` search), plus **exchange-consent
  gates** (Payer-to-Payer opt-in, Provider Access opt-out — both env-gated, off by default). Advertised
  in the CapabilityStatement.
- **Ops** — `/health` (liveness) + `/ready` (readiness), graceful SIGTERM/SIGINT shutdown,
  secure-by-default Docker Compose + production overlay, complete config reference.
- Sidecar pytest suite; server-boot smoke test in CI.
- **Interactive setup wizard** — `cd packages/server && npm run init`: guided walkthrough
  (deployment mode, storage backend incl. S3/GCS/Azure/MinIO/R2, security profile, auth,
  TLS, audit, HTTP hardening) that writes `deploy/.env`, can generate a persistent RS256
  OAuth signing keypair, previews the boot-time fail-closed posture check, and prints the
  exact run + IG-provisioning commands. Re-run safe (existing `.env` seeds defaults, backup on write).
- **`FHIRENGINE_VALIDATION_PROFILES`** — operator-configured conformance enforcement:
  an installed IG package id (e.g. `hl7.fhir.us.core`), profile canonical URLs, and/or
  `declared` (enforce each resource's `meta.profile` claims).
- **S3-compatible object stores** (MinIO / Cloudflare R2) — `AWS_ENDPOINT_URL`/`AWS_ENDPOINT`
  + `AWS_ALLOW_HTTP` wired through env/compose/wizard; verified end-to-end against MinIO.

### Changed
- **Profile validation is now opt-in** (`FHIRENGINE_VALIDATION_PROFILES`). By default the
  server validates against the installed FHIR version only (structure, invariants, base
  bindings); a resource claiming a profile in `meta.profile` is no longer rejected for
  missing that profile's constraints — real-world EHR exports routinely stamp profiles
  they don't fully satisfy. Set `FHIRENGINE_VALIDATION_PROFILES=declared` for the old behavior.

### Added (post-review hardening)
- **Docker deployment option** — prebuilt images published to GHCR on every release tag
  (`ghcr.io/fhirmedicconsulting/fhirengine-server` + `…-sidecar`), a
  `docker-compose.images.yml` overlay to run them without a build toolchain
  (`FHIRENGINE_IMAGE_TAG` pins a version), Deploy instructions in the root README, and a
  CI job that builds both images and boot-smokes the containerized stack to `/ready` on
  every push (the compose files were previously config-validated only).
- **Object-store startup discovery** — sidecar `/list-tables` (pyarrow.fs) enumerates Delta
  tables on s3://gs://az:// bases; `registerExistingTables()` uses it, so a restarted server
  finds tables it didn't write. `optimize-all` now works on object stores too. Verified
  end-to-end against MinIO (write → kill → fresh boot → discovery → read/search).
- **ValueSet expansion completeness tracking** (`valueset_header`) — IG loads record whether
  each expansion is complete; VSAC `$expand` pulls mark it complete (authoritative).

### Fixed
- **Partial ValueSet expansions no longer hard-reject valid codes** — a membership miss
  against a ValueSet whose compose couldn't be fully expanded locally (filter/intensional
  includes like US Core's LOINC document-type filter, valueSet imports, unloaded systems,
  excludes) now degrades to `unknown` (quarantine/pending) instead of `invalid` (422).
  Also: an intensional include on a *loaded* system no longer dumps the entire CodeSystem
  into the expansion (over-inclusion).
- Slice-qualified required bindings (e.g. US Core's optional `screening-assessment`
  Condition.category slice) were enforced against **every** node at the element path,
  false-rejecting valid resources — the slice qualifier lives in element `id`/`sliceName`,
  which the profile-spec extractor never checked.
- `docker-compose.yml` silently dropped most auth/OAuth/JWKS/TLS/rate-limit env vars
  (they were documented in `.env.example` but never passed to the server container).
- Validator caches are invalidated on IG install (freshly installed profiles are visible
  without a restart).

### Known limitations (pre-alpha)
- Not ONC (g)(10)-certified — individual US Core groups pass in Inferno; full suite not run end-to-end.
- Medallion promotion inside the repo is full-rebuild (idempotent backstop); CDF-incremental is available to external promoters, not yet built into the CLI.
- Composite/special search params + multi-field `_sort` are rejected under `Prefer: handling=strict`
  (not implemented as filters). L5 profile/IG conformance is partial (external HL7 validator is authoritative).
- **CMS-0057 prior-auth is FHIR-facing only** — PAS adjudication is a **stub** (no real Utilization
  Management / **X12 278** gateway), CRD returns an informational card (no **CQL** rule evaluation), and
  DTR packages forms but does not auto-populate. A CQL engine and X12 278 translation are large deferred
  components pending a component-disclosure/ADR (see `docs/standalone/cms-0057-b2b-apis-plan.md`). CARIN
  BB / PDex **profile conformance** (validating against those profiles) still requires IG install (L5).

[Unreleased]: https://github.com/FHIRmedicConsulting/fhirEngine/compare/v0.1.0-alpha.4...main
[0.1.0-alpha.4]: https://github.com/FHIRmedicConsulting/fhirEngine/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/FHIRmedicConsulting/fhirEngine/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/FHIRmedicConsulting/fhirEngine/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/FHIRmedicConsulting/fhirEngine/releases/tag/v0.1.0-alpha.1
