# Changelog

All notable changes to fhirEngine are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/) and is **pre-alpha** (`0.x` — anything may change).

## [Unreleased]

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

### Known limitations (pre-alpha)
- Not ONC (g)(10)-certified — individual US Core groups pass in Inferno; full suite not run end-to-end.
- Single-store serving only (medallion Gold read-path WIP); object-store restart-registration is local-FS only.
- Composite/special search params + multi-field `_sort` are rejected under `Prefer: handling=strict`
  (not implemented as filters). L5 profile/IG conformance is partial (external HL7 validator is authoritative).
- **CMS-0057 prior-auth is FHIR-facing only** — PAS adjudication is a **stub** (no real Utilization
  Management / **X12 278** gateway), CRD returns an informational card (no **CQL** rule evaluation), and
  DTR packages forms but does not auto-populate. A CQL engine and X12 278 translation are large deferred
  components pending a component-disclosure/ADR (see `docs/standalone/cms-0057-b2b-apis-plan.md`). CARIN
  BB / PDex **profile conformance** (validating against those profiles) still requires IG install (L5).

[Unreleased]: https://github.com/FHIRmedicConsulting/fhirEngine/commits/main
