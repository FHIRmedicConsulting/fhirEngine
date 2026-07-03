# RoninStandAlone — STATUS

_Living snapshot of where the project is. Point-in-time narrative + resume runbook live in
`docs/status/latest.md` (currently → session-033, 2026-07-02)._

**Product:** open-source (Apache-2.0), no-Databricks FHIR R4 server on OSS Delta Lake
(delta-rs / DataFusion via a Python sidecar; TypeScript/Hono REST tier). Local-first.

**Health:** **143 delta + 120 unit tests green · typecheck + lint clean · CI wired** · git working tree clean.
All 10 deep-review priorities (2026-07-02) are addressed — see `docs/status/2026-07-02-deep-review.md`
(§next actions there are now done) and the session log.

---

## What works today

| Area | Status |
|---|---|
| FHIR R4 REST surface | ✅ CRUD, history (instance/type/system), vread, CapabilityStatement, `$validate`, batch/transaction, conditional create/update/delete |
| Search | ✅ token/string/date/number/quantity/uri/**reference (bare-id + full)**, modifiers, chaining, `_has`, `_include`/`_revinclude`, `_sort`/`_summary`/`_elements`, paging, **GET + POST `_search`** |
| Operations | ✅ `$everything`, `$export` (dev), `$validate` |
| Validation (pre-Bronze) | ✅ structural + cardinality + **choice-type `[x]`** + terminology bindings (3-state) + FHIRPath invariants + installed-profile required-elements + slicing (first cut) |
| Transactions | ✅ urn:uuid resolution + **conditional references** (`Type?identifier=…` → literal) + **`ifNoneExist`** conditional create |
| Storage (Delta) | ✅ OPTIMIZE + VACUUM (all tables), **Z-order by `id`**, **current-version `is_current`** (atomic demote), **single-writer serialization + sidecar retry**, **startup table discovery** |
| Terminology | ✅ local store (752k concepts loadable) + **tx-server endpoints**: `ValueSet/$validate-code`, `CodeSystem/$validate-code`, `ValueSet/$expand`, `CodeSystem/$lookup` |
| Provisioning | ✅ IG install, operator file loaders (LOINC/SNOMED/RxNorm), VSAC `$expand`, quarantine-reconcile |
| Security (opt-in) | ✅ SMART scopes + JWKS auth, AuditEvent + accounting, consent + DS4P labels, obligations; ✅ **SMART discovery** (`.well-known/smart-configuration`) + 401/WWW-Authenticate |
| CapabilityStatement | ✅ US Core `supportedProfile` + `instantiates`, JSON-only `format`, SMART `oauth-uris`, terminology ops |

## Conformance — Inferno (g)(10)
Harness stood up (docker g10 kit); server driven headlessly. **Run 9 (2026-07-03) — validator LIVE:**
fixed the OOM (Docker VM → **12 GB** + validator **`-Xmx8g`**) and the base-URL mismatch (server
launched with **`RONIN_PUBLIC_URL=http://host.docker.internal:3000`** so paginated/revinclude links
are container-reachable). **Profile validation now executes** — `validation_test` **PASS** for Patient
+ Observation-lab (first time (g)(10) validation ran at all). The Encounter/DiagnosticReport
`validation_test` fails are **external `tx.fhir.org` terminology errors, not structural
non-conformance** (only error-level lines are remote-tx cache errors on SNOMED `Encounter.type`); fix
= point the validator at our **local** terminology server. Remaining `Could not find status/intent
values` search fails are **served correctly on direct probe** (harness value-extraction). Prior Run 8:
zero `fhir_client` crashes, Patient 10 PASS, clinical search/read/revinclude clean. Detail:
`docs/standalone/inferno-g10-findings.md` §Run 9; drivers: `docs/standalone/inferno/`.

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
at depth ≥2 · **medallion** Gold-read-path (single store is the supported topology) · object-store
**enumeration** for restart-registration + whole-store optimize · run the full **Inferno (g)(10)**
suites end-to-end (auth server + backend services now make the OAuth-gated suites reachable).

## Run / resume
See `docs/status/session-033-2026-07-02.md` §6 (rebuild `.delta-inferno` with **rsync**, start
sidecar+server, reload Synthea, drive Inferno). Tests: `npm run test:delta` (needs sidecar) ·
`npm run test:unit`.

## Not yet ratified / known debt
TS/Hono stack (ADR pending) · storage-topology ADR · `@ronin/fhir-types` codegen review · heritage
Databricks ADRs still in `docs/decisions/` for context.
