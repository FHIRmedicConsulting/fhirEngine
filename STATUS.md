# RoninStandAlone — STATUS

_Living snapshot of where the project is. Point-in-time narrative + resume runbook live in
`docs/status/latest.md` (currently → session-033, 2026-07-02)._

**Product:** open-source (Apache-2.0), no-Databricks FHIR R4 server on OSS Delta Lake
(delta-rs / DataFusion via a Python sidecar; TypeScript/Hono REST tier). Local-first.

**Health:** 16 commits · **120 delta + 120 unit tests green · tsc clean** · git working tree clean.

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
Harness stood up (docker g10 kit); server driven headlessly. **US Core v6.1.0**: Capability 4/4
code-checks, **Patient 11 PASS**, clinical groups (encounter/condition/document-reference/…) search
+ read + provenance-revinclude mostly PASS. 7 real defects found & fixed. Detail:
`docs/standalone/inferno-g10-findings.md`; drivers: `docs/standalone/inferno/`.

## Priorities (from the deep-dive)
Done: ✅#1 OPTIMIZE/VACUUM ✅#2 current-version ✅#2a Z-order ✅#3 concurrency ✅#4 Inferno started
✅ terminology server.
Open: #5 storage-topology switch wiring · #6 CI + real lint + release · #7 **SMART authorization
server** (gates OAuth (g)(10) suites) · #8 `$export` async persistence · #9 search/slicing
completeness · #10 config consolidation + TLS.

## Next best actions
1. **Broaden the tx surface** (validator batch `$validate-code` / `tx-resource` inline params) →
   land the end-to-end "Inferno validates via our tx" run.
2. **SMART authorization server** (`/authorize`, `/token`, launch context) — biggest remaining
   lever; unblocks full (g)(10) certification.

## Run / resume
See `docs/status/session-033-2026-07-02.md` §6 (rebuild `.delta-inferno` with **rsync**, start
sidecar+server, reload Synthea, drive Inferno). Tests: `npm run test:delta` (needs sidecar) ·
`npm run test:unit`.

## Not yet ratified / known debt
TS/Hono stack (ADR pending) · storage-topology ADR · `@ronin/fhir-types` codegen review · heritage
Databricks ADRs still in `docs/decisions/` for context.
