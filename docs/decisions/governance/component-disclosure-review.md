# Component Disclosure & Approval Review (flagged for Chad)

**Why this exists:** Components (frameworks, dependencies, external tools) were
introduced into the codebase — most notably **Hono** — that were **never disclosed
or explicitly approved**. Undisclosed components are an architecture, product, **and
security** problem (supply-chain provenance / SBOM; relevant to NIST 800-53 SA
controls and our PHI posture, [[phi-security-standards]]). This is the audit of
current components with disclosure + approval status. **Items marked ⚠️ NEEDS REVIEW
are awaiting Chad's explicit approve/replace/remove decision.**

Status legend: ✅ approved (explicit Chad decision or ratified ADR) · ⚠️ needs review
(undisclosed / un-ratified) · ❌ remove (wrong product / dead).

> **Update 2026-07-04 (reconciliation):** the previously-flagged items are resolved — **TS/Hono +
> @hono/node-server + pino + the toolchain (tsx/vitest/typescript) are ratified by ADR-0029**;
> **`@databricks/sql` is removed** (0 refs in src + lockfile); the **heritage `src/auth/` module is
> ratified by ADR-0030**. New security deps added since (all **Node/Hono built-ins + existing `jose`**,
> **no new runtime dependency**) are covered by ADR-0031..0036. Rows below updated accordingly.
> **New runtime deps (approved by Chad 2026-07-04):** `pkijs` + `asn1js` — pure-JS PKI for **live CRL + OCSP
> revocation** (ADR-0036): download + signature-verify a certificate's CRL. No native build; `npm audit`
> clean.
> **Optional, operator-installed (NOT in the dependency tree):** `ioredis` — lazy-imported only when
> `FHIRENGINE_RATE_LIMIT_STORE=redis` for shared multi-node rate limiting (ADR-0033); single-node never loads
> it. `@vitest/coverage-v8` — dev-only (coverage gate). All disclosed here.

## Production server — `packages/server`

| Component | Version | Role | Provenance | Status |
|---|---|---|---|---|
| **hono** | ^4.6.0 | **web framework** (+ built-in `secure-headers`/`cors`/`body-limit` used by ADR-0033) | heritage fork | ✅ **approved** — ratified by **ADR-0029** |
| **@hono/node-server** | ^1.13.0 | Node HTTP adapter for Hono | heritage | ✅ approved (ADR-0029) |
| ~~**@databricks/sql**~~ | — | Databricks SQL driver | heritage | ✅ **REMOVED** — 0 refs in src + lockfile (the standalone uses delta-rs/DataFusion) |
| **pino** | ^9.5.0 | logging | heritage | ✅ approved (ADR-0029). Follow-up: add `redact` paths (PHI-safe logs) |
| **zod** | ^3.23.0 | REST-boundary validation | endorsed by Chad session 032 ("compliant with Zod") | ✅ approved |
| **fhirpath** | ^4.11.0 | L4 FHIRPath invariant validation | added session 032 (BSD; identified in research) for the shared TS ValidationSupportChain | ✅ approved (in use; 0 vulns) |
| **jose** | ^5 | JWT/JWKS verification for the auth gate (ADR-0030) | session 032 — security best practice is to NOT hand-roll JWT/crypto; `jose` is the standard audited lib (MIT) | ✅ approved (Chad, session 032; ADR-0030 Accepted) |
| **heritage `src/auth/` module** | — | SMART/UDAP auth-middleware, scope-enforcer, multi-version SMART, consent-gate (DS4P), data-filter, token-introspection, IdP abstraction | heritage fork; wired for the standalone in session 032 | ✅ **approved** — ratified by **ADR-0030**; the new `src/auth/oauth/` (SMART auth server + Backend Services) + `src/auth/udap/` (ADR-0036) build on it (jose only). Check `openid-client` before enabling the OIDC strategy. |
| **@fhirengine/fhir-types** | file: | generated FHIR R4 types (first-party) | internal | ✅ first-party |
| @types/node, **tsx**, typescript, **vitest** | dev | build/test tooling | heritage | ✅ approved (ADR-0029 toolchain) |

## Types codegen — `packages/fhir-types`

| Component | Role | Status |
|---|---|---|
| **@atomic-ehr/codegen** ^0.0.10 | generates the FHIR TS types (produces product code — pre-1.0, single source) | ⚠️ NEEDS REVIEW (third-party codegen for product types; provenance worth ratifying) |
| graceful-fs, tsx, typescript | support/tooling | ⚠️ low-risk, list for completeness |
| hl7.* FHIR packages | FHIR definitions (data, not code) | ✅ HL7 (CC0/spec) |
| **R4 SearchParameters** (vendored `src/fhir-schema/r4-search-params.json`, session 032) | per-resource search registry (token/string/date/reference/uri + FHIRPath expr), generated from hl7.fhir.r4.core SearchParameters | ✅ CC0 R4 Core data — same class as the already-vendored R4 StructureDefinitions (`r4-core-schemas.json`); evaluated at runtime via the approved **fhirpath**. Disclosed for completeness. |

## Standalone storage (session-introduced) — disclosed via ADRs

| Component | Role | Status |
|---|---|---|
| **deltalake** (delta-rs, Python) | Delta write/MERGE/CDF | ✅ approved (ADR-0022 + A1; Chad decisions) |
| **DataFusion** (bundled in deltalake) | read engine | ✅ approved (ADR-0022 A1) |
| **pyarrow** | Arrow tables for the sidecar | ✅ approved (ADR-0022; sidecar) |
| Python runtime + delta sidecar | storage process | ✅ approved (ADR-0022 A1; runtime decision) |

## POC-only (scratch — NOT product; quarantine/remove)

| Component | Where | Status |
|---|---|---|
| **@duckdb/node-api** | poc/delta-flatten-poc | ❌ DuckDB dropped (ADR-0022 A1) — remove from plan; POC artifact only |
| **fastapi / uvicorn** | poc/python-fhir-poc | ❌ Python-native path NOT chosen (session 032) — reference POC only |
| @databricks/sql, uuid, express, ts-node | poc/* | heritage POC scratch — not product |

## Remediation (recommended, pending Chad)

1. **Ratify the runtime/stack** — write the never-written replacement for the
   rejected ADR-0002: explicitly approve (or replace) **TS/Node + Hono +
   @hono/node-server + pino + the dev toolchain** as fhirEngine's stack. This
   closes the biggest gap (the foundational stack has no ratifying decision).
2. **Remove `@databricks/sql`** from `packages/server` (and standalone POCs)
   — it's the Databricks coupling the product sheds; keep it only in Ronin.
3. **Ratify `@atomic-ehr/codegen`** (or pin/vendor) — it generates product types from
   a pre-1.0 single-source tool; provenance matters for a PHI product.
4. **Quarantine POC leftovers** — DuckDB / FastAPI deps live only in `poc/` and are
   not product; mark them clearly so they aren't mistaken for the chosen stack.
5. **Maintain an approved-dependency list / SBOM** going forward as part of the
   security posture ([[phi-security-standards]]); every new component gets disclosed +
   approved before adoption ([[component-disclosure-policy]]).

## npm audit (session 032, 2026-06-28) — 8 vulns (1 critical / 3 high / 4 moderate)

- **HIGH — `thrift` (via `@databricks/sql`)**: Uncontrolled Recursion + Path
  Traversal / request-splitting advisories; **no upstream fix available**. Plus a
  moderate `uuid` it depends on. → **Removing `@databricks/sql` eliminates these.**
  Standalone doesn't use it; the server uses its own `uuid-v7`. Strongest reason yet to
  remove (security + ADR-0028 legacy + this review). Ratified in ADR-0029.
- **MODERATE — `esbuild`→`vite`→`vitest`** (dev/test only, not shipped): fixable via a
  deliberate `vitest@4` bump (breaking, test-only).
- Action: (1) remove/optionalize `@databricks/sql` (kills the high vulns); (2) deliberate
  `vitest@4` upgrade for the dev advisories. Both are approved dependency changes per
  [[component-disclosure-policy]] — recommended, awaiting go-ahead.

## Note on how this happened
Hono and the rest entered with the **verbatim heritage fork** from Ronin; the session
work then built on them without flagging that they were un-ratified — the same
inherited-assumption failure mode as DuckDB and the DynamoDB caveat. The standing
policy ([[component-disclosure-policy]]) exists to prevent recurrence.
