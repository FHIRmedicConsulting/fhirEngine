# ADR-0030: Standalone Security, Privacy & Consent — server-side ENFORCEMENT

- Status: **Accepted** 2026-06-28 (Chad — "let's give it a go"; full implementation + security auditing in scope) — the standalone adaptation of the heritage security ADRs, scoped to what the **Ronin server** enforces. `jose` approved.
- Date: 2026-06-28
- Decider(s): Chad
- Session: 032 (standalone fork)
- Related: [ADR-0006](0006-smart-on-fhir-and-udap-security.md) (SMART/UDAP), [ADR-0016](0016-audit-and-access-transparency.md) (audit), [ADR-0018](0018-patient-portal-consent-and-read-time-filter.md) (consent read-time filter), [ADR-0010](0010-storage-shape.md) (integrity/provenance), [[phi-security-standards]], [[storage-topology]], `Research_report_FHIR_Privacy_Security_and_Consent.md`, [docs/governance/component-disclosure-review.md](../governance/component-disclosure-review.md)

## Context

PHI is in scope ([[phi-security-standards]]): HIPAA Security Rule §164.312 (access control,
audit, integrity, authn, transmission), HITECH (accounting of disclosures), 42 CFR Part 2
(SUD; 2024 Final Rule → single-consent TPO, enforced 2026-02-16), and DS4P security
labeling (`Resource.meta.security` — HCS confidentiality N/R/V + sensitivity ETH/PSY/HIV/SUD
+ obligation/refrain codes incl. `PROCESSINLINELABEL`). The standalone delta app currently
ships with **no** auth/audit/consent wiring (synthetic-data-only).

**Division of responsibility (Chad, session 032):** the Ronin server **respects and
enforces** security/privacy/consent; it does **NOT tag** resources. The *tagging* (applying
`meta.security` labels, DS4P segmentation) and the Bronze→Silver/Gold consent segmentation
are performed by a **separate governance/ELT app** (e.g. the Dagster pipeline in
`eltResearch/fhir_consent_security_standards.md`). Feature sets differ between single-store
and medallion deployments **upstream of the server**; the **server's enforcement is identical
in both** — it consumes whatever `meta.security` + `Consent` exist and enforces them.

## Decision — the server enforcement controls

The server implements these controls; all are **topology-agnostic** and consume
externally-produced labels/consent.

1. **AuthN / AuthZ (ADR-0006).** Bearer **JWT** verified against a configured **JWKS**
   (SMART/UDAP-shaped). Claims carry `scope` (SMART scopes), `purpose_of_use`,
   `clearance`/role, and patient context. Every interaction is authorized against the
   required SMART scope (resource type + interaction); deny → `401`/`403`.
2. **Audit (ADR-0016, HITECH).** Every PHI access emits an **AuditEvent**
   (agent/action/entity/outcome/source), to a dedicated audit store; supports accounting
   of disclosures. Audit is **not** suppressible by consent (we log the access + decision).
3. **Computable consent — read-time (ADR-0018).** Evaluate the patient's **active
   `Consent`** provisions (`type` permit/deny, `securityLabel`, `actor`, `action`,
   `purpose`, `period`, `provision.data`) → **permit / deny / redact** at read and search.
4. **Security-label enforcement (DS4P).** Honor `meta.security`: compare resource
   **confidentiality/sensitivity** against requester **clearance + purpose-of-use** →
   permit / deny / **redact**; apply **obligation/refrain** codes; **42 CFR Part 2**
   resources are consent-gated and carry a redisclosure-prohibition notice.
   `PROCESSINLINELABEL` (element-level) is a later phase.
5. **Minimum necessary + integrity.** Scope/purpose-limited responses; TLS in transit
   (deploy); provenance/versioning (ADR-0010, already present).

**Requester-clearance model:** derived **only** from the verified token claims (scopes +
purpose-of-use + clearance/role + patient) — never from request-asserted headers. Dev uses
a local signing key + JWKS; production points JWKS at the real IdP. No IdP is stood up by
this ADR.

**Enablement:** enforcement is **opt-in by config** (e.g. `RONIN_AUTH_ENABLED`,
`RONIN_CONSENT_ENFORCEMENT`), default **off**, so synthetic-data dev + the existing test
suite are unaffected until a deployment turns it on. (Production PHII deployments MUST
enable them — recorded as a deploy-gate, not a code default.)

## Scope

**In (server enforces):** controls 1–5 above; reading `meta.security` + `Consent`;
emitting AuditEvent; scope/clearance/consent decisions; redaction of denied
fields/resources (with FHIR `data-absent-reason` / security-label rationale).

**Out (NOT the server):** *generating/applying* `meta.security` labels (DS4P tagging),
sensitive-condition classification (SAMHSA Consent2Share value-set matching), and the
Bronze→Silver/Gold consent segmentation — all in the external governance/ELT app. The
server trusts those labels as the integrity boundary.

## Dependency disclosure (per [[component-disclosure-policy]])

- **`jose`** (JWT/JWKS verification) — proposed. Security best practice is to **not
  hand-roll** JWT/crypto; `jose` is the standard, audited library. **Flagged for approval**
  in the component-disclosure review; nothing is built on it until approved.

## Implementation note (session 032) — reuse the heritage auth module

A mature, **backend-agnostic** heritage auth module already exists in `src/auth/`
(auth-middleware, **scope-enforcer**, multi-version **SMART parsing** 1.0–2.2,
**consent-gate** with DS4P sensitivity codes, data-filter, token-introspection, an IdP
abstraction with a dev **stub**) — it had simply **never been wired into the delta app**.
Decision: **reuse it** rather than rebuild (controls #1/#3/#4 are largely there; aligns with
the sister-codebase ethos). The only genuinely missing piece — the **JWKS/local-JWT
strategy** (this ADR's chosen authN model, explicitly noted as unimplemented in
`idp/oidc-auth.ts`) — was added as `idp/jwks-auth.ts` (jose). The heritage module is
**flagged for disclosure/ratification** (un-ratified like the rest of the heritage fork;
ADR-0006 covers its design).

**Phase 1 DONE:** heritage `authMiddleware` wired into the delta app via `auth/configure.ts`
(opt-in `RONIN_AUTH_ENABLED`; strategy `stub|jwks|oidc` via `RONIN_AUTH_STRATEGY`); /health
+ /metadata public; verified `AuthContext` on `c.var.auth`. Tests `delta-auth` (8).

## Phased plan

1. **Auth gate** — JWT/JWKS middleware + SMART scope enforcement (this ADR's first build). ✅
2. **AuditEvent** — emit on every interaction. ✅ **Phase 2 DONE:** reused the heritage
   audit **builder + middleware** (loosened its dep to an `AuditSink` interface); new
   **delta-native `DeltaAuditSink`** (serialized appends — single-writer-safe; empty-string
   columns for Utf8 stability) + `audit/configure.ts` (opt-in `RONIN_AUDIT_ENABLED`, mounted
   BEFORE the auth gate so 401/403 are audited). `findByPatient` = accounting-of-disclosures.
   Tests `delta-audit` (3).
3. **Consent + security-label read-time engine** — permit/deny/redact. ✅ **Phase 3 DONE
   (label/scope-context policy):** reused heritage `consent-gate` (HCS confidentiality
   U/L/M/N/R/V + sensitivity ETH/PSY/HIV/SUD… + scope-context policy) via
   `auth/consent-enforce.ts` (opt-in `RONIN_CONSENT_ENFORCEMENT`; standalone compartment
   resolver for all types). Wired into read/vread (403) + search/$everything (filter the
   page; total = visible count so it doesn't leak hidden records). Tests `delta-consent` (4):
   system allowed · user blocked on R/sensitive · search filters sensitive · patient
   compartment isolation. ✅ **Phase 3b DONE (computable-consent override):** when the default
   policy denies a sensitive/restricted resource, load the patient's **active `Consent`**
   (via `findReferencing(['patient','subject'])`) and **grant** if a `permit` provision covers
   the blocking label for the requester (actor/purpose/period; empty list = wildcard; nested
   provisions). Test added (Consent permit grants the blocked ETH read). 96 delta green.
4. **Obligations + 42 CFR Part 2 specifics + `PROCESSINLINELABEL`** (element-level). ✅
   **Phase 4 DONE:** `auth/redact.ts` — **42 CFR Part 2 redisclosure notice** (stamp
   `NORDSCLCD` on disclosed SUD/ETH resources) + **element-level inline-label redaction**
   (mask fields carrying an inline DS4P label the requester can't see → `data-absent-reason:
   masked` + `REDACTED` meta). `applyObligations` wired into read/vread/search/$everything
   (after consent allows). Test `delta-obligations` (3). **99 delta + 358 unit green.**
5. **Minimum-necessary polish, transmission/ATO hardening.**

## Consequences

- Closes the standalone's nascent-enforcement gap on the record; keeps Ronin and
  RoninStandAlone aligned (ADR-0028) since both enforce the same controls.
- The enforce-not-tag boundary keeps the server simple and makes the *label producer* the
  trust root — labels must be integrity-protected upstream (NIST SA; [[phi-security-standards]]).
- Opt-in default avoids breaking dev/tests but means **production enablement is a deploy
  gate** that must be verified (ties to the install-audit/runbooks, ADR-0021).
