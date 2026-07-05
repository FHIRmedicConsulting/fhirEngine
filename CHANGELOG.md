# Changelog

All notable changes to fhirEngine are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/) and is **pre-alpha** (`0.x` — anything may change).

## [Unreleased]

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
- Single-store serving only (medallion Gold read-path WIP).
- Composite/special search params + multi-field `_sort` are rejected under `Prefer: handling=strict`
  (not implemented as filters). L5 profile/IG conformance is partial (external HL7 validator is authoritative).
- **CMS-0057 prior-auth is FHIR-facing only** — PAS adjudication is a **stub** (no real Utilization
  Management / **X12 278** gateway), CRD returns an informational card (no **CQL** rule evaluation), and
  DTR packages forms but does not auto-populate. A CQL engine and X12 278 translation are large deferred
  components pending a component-disclosure/ADR (see `docs/standalone/cms-0057-b2b-apis-plan.md`). CARIN
  BB / PDex **profile conformance** (validating against those profiles) still requires IG install (L5).

[Unreleased]: https://github.com/FHIRmedicConsulting/fhirEngine/compare/v0.1.0-alpha.1...main
[0.1.0-alpha.1]: https://github.com/FHIRmedicConsulting/fhirEngine/releases/tag/v0.1.0-alpha.1
