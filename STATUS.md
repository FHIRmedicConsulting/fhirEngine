# fhirEngine — STATUS

_Living snapshot of where the project is._

**Product:** open-source (Apache-2.0), no-Databricks FHIR R4 server on OSS Delta Lake
(delta-rs / DataFusion via a Python sidecar; TypeScript/Hono REST tier). Local-first.

**Health:** **205 integration + 364 unit + 16 sidecar (pytest) green · typecheck + lint clean · CI hardened**
(unit · supply-chain audit/SBOM/pip-audit · gitleaks+Trivy scan · integration w/ fail-hard sidecar +
boot smoke · release workflow). Two internal deep reviews (2026-07-02, and the OSS-alpha
review 2026-07-04) fully addressed
(all 10 items done — deploy secure-by-default, honest claims, SECURITY.md/CONTRIBUTING/CoC, config
reference, unsupported-search rejection, ADR-0023 ratified + NOTICE, graceful shutdown + `/ready`,
sidecar tests). External coverage audit (2026-08-05) closed: the flagged zero-coverage
clinical/security modules (data filtering, `$export` job store/route, search indexing, terminology
loaders + reconciler, JWKS/OIDC strategies, OAuth store) now carry dedicated unit suites at 94–100%
line coverage.

---

## What works today

| Area | Status |
|---|---|
| FHIR R4 REST surface | ✅ CRUD, history (instance/type/system), vread, CapabilityStatement, `$validate`, batch/transaction, conditional create/update/delete |
| Search | ✅ token/string/date/number/quantity/uri/**reference (bare-id + full)**, modifiers, chaining, `_has`, `_include`/`_revinclude`, **multi-field `_sort`**/`_summary`/`_elements`, paging, **GET + POST `_search`**, **composite params** (Observation code/combo/component `code-value-quantity|concept|date|string` — same-element semantics via composite index rows). Special params + unregistered composites are NOT silently ignored — rejected under `Prefer: handling=strict` (unknown params lenient-ignored by default per FHIR) |
| Operations | ✅ `$everything` (paged + _since), `$export` (async, disk-backed), `$validate`, **`Patient/$member-match`** (HRex, CMS-0057 Payer-to-Payer) |
| Validation (pre-Bronze) | ✅ structural + cardinality + **unknown/typo'd-element rejection** + **choice-type `[x]`** + terminology bindings (3-state) + **L4 FHIRPath invariants (any-depth contexts, R4-model-aware, `[x]` choice fan-out)** + installed-profile **required-elements + required bindings + required (value/pattern) slices** — **operator-opt-in** via `FHIRENGINE_VALIDATION_PROFILES` (package id / canonical URL / `declared`; default = base FHIR only) (NOT full L5 IG conformance — no type/profile discriminators or must-support; the authoritative profile verdict is the external HL7 validator) + slicing (value/pattern discriminators; **min + max + closed rules**, conservatively skipped when discriminators aren't extractable) |
| Transactions | ✅ urn:uuid resolution + **conditional references** (`Type?identifier=…` → literal) + **`ifNoneExist`** conditional create |
| Storage (Delta) | ✅ OPTIMIZE + VACUUM (all tables), **Z-order by `id`**, **current-version `is_current`** (atomic demote), **single-writer serialization + sidecar retry**, **startup table discovery** (local FS **and object stores** via sidecar `/list-tables`, pyarrow.fs; verified vs MinIO) + **medallion serving** (`FHIRENGINE_STORAGE_MODE=medallion`: Bronze ingest → Gold serving; external promotion — Dagster/Databricks/`fhirengine-promote`; CDF enabled at Bronze/Silver creation) |
| Terminology | ✅ local store (752k concepts loadable) + **tx-server endpoints**: `ValueSet/$validate-code`, `CodeSystem/$validate-code`, `ValueSet/$expand`, `CodeSystem/$lookup` |
| Provisioning | ✅ IG install, operator file loaders (LOINC/SNOMED/RxNorm), VSAC `$expand`, quarantine-reconcile |
| MPI / dedup (ADR-0012 v1) | ✅ **deterministic dedup enforced at promotion** (shared-identifier match, hard-deny guardrails → `patient_match_review`, survivor=latest-write, merged record read-only w/ `replaced-by`, downstream reference rewrite, `patient_link`+`patient_merge_history`+merge Provenance in Gold; `FHIRENGINE_MPI=off` to disable). Splink/PPRL = external pipeline |
| Security (enforcement) | ✅ SMART scopes + JWKS auth, **Backend Services** (client_credentials+private_key_jwt), **UDAP B2B trust** (cert-chain software statements + **revocation: static list + live signature-verified CRL + OCSP** + **trusted DCR w/ durable registry** + **signed_metadata** + **tiered OAuth/RFC 9101 signed request** + **RFC 5280 path validation** (basic constraints / key usage / name constraints), opt-in), AuditEvent + accounting, consent + DS4P labels, obligations; ✅ **SMART discovery** + 401/WWW-Authenticate |
| Security (infrastructure) | ✅ **hardened TLS** (SP 800-52r2, TLS1.2+, **cert hot-reload**), **production fail-closed profile**, **HTTP hardening** (headers, enforced CORS, rate limiting — **pluggable + Redis shared store**, body limits), **audit hash-chain tamper-evidence** (`fhirengine-audit-verify`) + **external anchoring** (rewrite/truncation detection), **UDAP B2B trust** + **cert revocation**, **SBOM + npm-audit + pip-audit + gitleaks + Trivy CI** + coverage gate — `docs/standalone/security-hardening-and-deployment.md` (ADR-0031..0036, Accepted) |
| CapabilityStatement | ✅ US Core `supportedProfile` + `instantiates`, JSON-only `format`, SMART `oauth-uris`, terminology ops, `TerminologyCapabilities` (`?mode=terminology`) |

## Conformance — Inferno (g)(10)
> **Honest status:** this is **not** an ONC certification claim — do not say "passes (g)(10)."
> What IS verified (Runs 12–17, 2026-08-05/06): **every functional (g)(10) group passes with zero
> test failures over TLS** — Standalone Full/Limited, EHR Practitioner, Additional Authorization
> (297), Multi-Patient STU1+STU2, Single Patient API US Core 6.1.0 (202) — driven headlessly
> against the real kit with auth ON over the hardened TLS listener. Attestations carry 3 declared
> deployment-layer gaps (consent GUI, offline-access notice, public base-URL publication). Before
> a real ONC attempt: those deployer items, richer test data (data-absent skips), CA-signed certs,
> certification-grade deployment. Detail: `docs/standalone/inferno-g10-findings.md` Runs 12–17.

Harness stood up (docker g10 kit); server driven headlessly. **Run 9 (2026-07-03) — validator LIVE:**
fixed the OOM (Docker VM → **12 GB** + validator **`-Xmx8g`**) and the base-URL mismatch (server
launched with **`FHIRENGINE_PUBLIC_URL=http://host.docker.internal:3000`** so paginated/revinclude links
are container-reachable). **Profile validation now executes** — `validation_test` **PASS** for Patient
+ Observation-lab (first time (g)(10) validation ran at all). The Encounter/DiagnosticReport
`validation_test` fails are **external `tx.fhir.org` terminology errors, not structural
non-conformance** (only error-level lines are remote-tx cache errors on SNOMED `Encounter.type`); fix
= point the validator at our **local** terminology server. Remaining `Could not find status/intent
values` search fails are **served correctly on direct probe** (harness value-extraction). **Run 10**
(terminology config): **Option B (suppress external tx.fhir.org errors, ONC-aligned) WORKS** — with tx
filters added to both suites, Encounter/DiagnosticReport `validation_test` now PASS (our data is
US-Core-conformant; failures were flaky external tx, not our data). **Option A finished (Run 11): NOT achievable** — TLS
solved (TLS listener + cert in validator truststore) and TerminologyCapabilities handshake added
(`/metadata?mode=terminology`, 1157 systems), but the HL7 validator **deliberately refuses** any tx
server not approved via HL7's FHIR Terminology Ecosystem conformance program ("not approved… does not
pass the required tests"); **no bypass flag exists**. Our tx endpoint is for our own clients, not the
cert validator — Option B is the correct path (and is what ONC's hosted validator does). Kept the
`TerminologyCapabilities` endpoint (standards-compliant improvement). Prior Run 8:
zero `fhir_client` crashes, Patient 10 PASS, clinical search/read/revinclude clean. Detail:
`docs/standalone/inferno-g10-findings.md` §Run 9.

## Priorities (from the deep-dive)
Done: ✅#1 OPTIMIZE/VACUUM ✅#2 current-version ✅#2a Z-order ✅#3 concurrency ✅#4 Inferno started
✅ terminology server.
Open: #5 storage-topology switch wiring · #6 CI + real lint + release · #7 **SMART authorization
server** (gates OAuth (g)(10) suites) · #8 `$export` async persistence · #9 search/slicing
completeness · #10 config consolidation + TLS.

## Deep-review follow-ups (2026-07-02) — all 10 DONE
✅ compartment enforcement · ✅ version TOCTOU · ✅ CapabilityStatement accuracy · ✅ **SMART
authorization server** (`/oauth/authorize`+`/token`+PKCE+refresh+OIDC+JWKS) · ✅ profile-enforcement
depth (nested required + profile bindings) · ✅ async disk-backed `$export` · ✅ prod hardening
(500-sanitize, audit-failure log, TLS, non-root Docker+HEALTHCHECK, CI, real ESLint) · ✅ tx-endpoint
breadth (codeableConcept validate, `$expand` filter/paging/total) · ✅ search completeness (numeric
`_sort`, `_include:iterate`, `_revinclude` guard) · ✅ `is_current` migration.

## Remaining follow-ups (explicitly deferred, lower priority)
✅ SMART **Backend Services** (client_credentials + private_key_jwt) — DONE. Remaining:
**composite** search params + multi-field `_sort` (codegen) · slicing max/closed + L4 invariants
at depth ≥2 · CDF-incremental promotion inside `fhirengine-promote` (full-rebuild is the shipped
reference; external promoters can already use CDF) · run the full **Inferno (g)(10)** suites
end-to-end (auth server + backend services now make the OAuth-gated suites reachable).

## Run / resume
Guided setup: `cd packages/server && npm run init` (writes `deploy/.env`, prints run +
provisioning commands). Tests: `npm run test:delta` (needs sidecar) · `npm run test:unit`.

## Security infrastructure (2026-07-04, ADR-0031..0036 Accepted)
Alpha security baseline built + the ranked deferred items: **#1** TLS hardening (SP 800-52r2 + cert
hot-reload) · prod fail-closed profile · HTTP hardening (headers/CORS/rate-limit/body-limit, pluggable
store) · SBOM+audit+gitleaks+Trivy CI. **#2** audit hash-chain tamper-evidence (`fhirengine-audit-verify`).
**#3** UDAP B2B trust foundation (cert-chain software statements + trusted DCR + `.well-known/udap`).
**#4** CMS-0057 B2B APIs = **plan** (`docs/standalone/cms-0057-b2b-apis-plan.md`) — multi-week program,
not built. Runbook: `docs/standalone/security-hardening-and-deployment.md`. Gap analysis:
`docs/research/2026-07-03-tls-and-cms-compliance-security-deep-dive.md`.

## Not yet ratified / known debt
TS/Hono stack (ADR pending) · storage-topology ADR · `@fhirengine/fhir-types` codegen review · heritage
Databricks ADRs still in `docs/decisions/` for context. UDAP follow-ups (revocation/CRL-OCSP, tiered
OAuth, persistent registry) before real-partner B2B; shared-store rate limiter + external audit
anchoring post-Alpha.
