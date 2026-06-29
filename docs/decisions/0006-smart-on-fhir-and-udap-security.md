# ADR-0006: SMART on FHIR + UDAP Security — v1 Ships Both, Hybrid UDAP Gateway, Customer-Supplied OIDC IdP, Five-Point Scope+Consent Enforcement

- Status: **Accepted**
- Date: 2026-06-20
- Decider(s): Chad
- Session: 019
- Related: [ADR-0010](0010-storage-shape.md) (Patient compartment), [ADR-0011](0011-write-contract.md) §6 (auth handoff), [ADR-0012](0012-master-patient-index.md) §6 (`$match` / TEFCA PPRL), [ADR-0013](0013-deployment-posture.md) (Apps-hosted), [ADR-0014](0014-conformance-targets-and-ig-matrix.md) §1 + §10 (IG matrix + CapabilityStatement), [ADR-0016](0016-audit-and-access-transparency.md) §2.1.1 + §5 + §8.1 (OAuth events + scope capture), [ADR-0017](0017-terminology-service.md) §9 (terminology endpoint scopes), [ADR-0018](0018-patient-portal-consent-and-read-time-filter.md) (Consent gate referenced in §5 point 5), [docs/research/2026-06-19-smart-on-fhir-and-udap-landscape.md](../research/2026-06-19-smart-on-fhir-and-udap-landscape.md)

## Context

ADR-0006 has been on the critical path since session 002 and was deferred until enough of the surrounding architecture stabilized that the auth substrate could be locked without rework. After ADR-0011 / ADR-0012 / ADR-0014 / ADR-0016 / ADR-0017 all landed with `ADR-0006 queued` cross-references, the dependency dam burst. Session 019 closes it.

The original "SMART on FHIR specifics" framing turned out to be incomplete. UDAP — the Unified Data Access Profiles federal trust framework, codified in the HL7 FHIR UDAP Security IG (SSRAA) — became operational reality during the 18 months leading into this ADR. The HL7 FAST Security adoption deadline was **01/01/2026 — already past as of this ADR's date**. TEFCA QHIN designation explicitly references SSRAA. Any payer customer planning TEFCA participation needs UDAP on day one, not as a fast-follow.

This ADR ratifies the SMART + UDAP posture for v1 and locks the architecture for the surrounding ADRs that have been deferring to it.

**What this ADR does NOT own** (deferred to other ADRs to keep the scope tight):

- **Patient consent enforcement mechanics** — owned by ADR-0018 (Patient Portal + Consent + Read-Time Filter). §5 point 5 of this ADR plugs into ADR-0018's gate as a cross-reference.
- **Security label tagging** — owned by ADR-0015 Amendment 2 (Security Labeling Service). The classification mechanism that makes Consent.provision.securityLabel meaningful lives in the Bronze→Silver Governance step.
- **TEFCA Patient IAL2 workflow** — patient identity-proofing flow for cross-QHIN consumer-mediated exchange; lives in a future TEFCA participation ADR.

## Decision

### 1. Three-leg conformance stack — operations, server requirements, federal trust

| Leg | Source | Pinned version (v1) | What it gives Ronin |
|---|---|---|---|
| **SMART App Launch** | `hl7.fhir.uv.smart-app-launch` | 2.0.0 floor (CMS-0057-F adopted), 2.2.0 latest, both shipped in the catalog per ADR-0014 §2 | User-facing OAuth/OIDC, system-to-system Backend Services, v2 `.cruds` scope grammar with v1 back-compat, PKCE S256, `cache-id` parameter coordination with ADR-0017's hot read path |
| **FHIR core auth substrate** | FHIR R4 spec | 4.0.1 | OAuth 2.0 / OIDC primitives, token introspection (RFC 7662), CapabilityStatement security declarations |
| **HL7 FHIR UDAP Security IG (SSRAA)** | `hl7.fhir.us.udap-security` | 1.0.0 | Federal trust framework: x.509 certificate-based client identity, JWT-bearer client authentication, Dynamic Client Registration (DCR), Tiered OAuth (v2+) |

The Ecosystem-IG-style discovery pattern from ADR-0017 §1 also applies here: `/metadata` for CapabilityStatement, `/.well-known/smart-configuration` for SMART discovery, `/.well-known/udap` for UDAP discovery. All three published from the same TS App per ADR-0013.

### 2. v1 ships both SMART and UDAP

Both substrates are GA scope, not phased. A `payer_baseline` deployment lights up:

- SMART App Launch (user-facing patient portal flows) — Patient Access API.
- SMART Backend Services (system-to-system) — Provider Access, Payer-to-Payer, Prior Authorization.
- UDAP DCR + JWT-bearer auth — TEFCA-eligible cross-QHIN system-to-system trust.

A `provider_baseline` deployment (future v1.x) reduces the SMART surface but keeps UDAP as it remains the federal trust path.

The trade considered and rejected: a phased GA with SMART-only v1 and UDAP fast-follow v1.1. The SSRAA deadline being past means TEFCA-participating payer customers can't deploy a SMART-only Ronin; they'd need a separate UDAP solution layered alongside, defeating the single-deployment-unit story from ADR-0013. The decision is to absorb the larger GA scope.

### 3. UDAP gateway shape — hybrid (inline default + delegated, per-deployment configurable)

Two distinct trust surfaces — they must not be conflated:

| | Patient/User IdP | UDAP gateway |
|---|---|---|
| Question answered | Who is this human? Is identity IAL2-proofed? | Who is this calling SYSTEM? Is the cert from a TEFCA-trusted CA? |
| Inputs | Human auth + MFA + identity proofing | x.509 client certificate + signed software statement |
| Outputs | `id_token` + `access_token` + `refresh_token` (OIDC) | `client_id` + system `access_token` |
| In Ronin | Always customer-supplied (no Ronin-hosted IdP) | Configurable: inline or delegated |

The UDAP gateway ships in two modes selected per deployment:

- **`ronin_udap_mode = inline` (default)** — DCR endpoint + JWT-bearer validation + trust-bundle management runs in the TS App. The customer brings an OIDC IdP (Okta, Entra, Cognito, Login.gov, id.me, custom); Ronin handles the system-to-system trust surface end-to-end. Fits the Okta/Entra/Cognito-customer + smaller-payer ICPs.
- **`ronin_udap_mode = delegate`** — DCR endpoint is mounted on the customer's existing UDAP gateway (Ping Identity, ForgeRock, or a federal-contract-mandated UDAP CA setup). Ronin's TS App receives access tokens from the customer's gateway and introspects normally via `ronin_udap_introspection_url`. Fits the Ping/ForgeRock + federal-contract ICPs.

Both modes coexist at GA. Customers pick at deploy time; can switch by re-deploying. No code path forks beyond the configurable introspection target.

### 4. Customer-supplied OIDC IdP — explicit support list

Ronin does NOT host an IdP. Customers integrate their existing IdP via OIDC. v1 explicitly supports:

| IdP | Notes |
|---|---|
| **Okta / Auth0** | Most common payer choice; requires the Okta SMART-on-FHIR reference impl (authorization proxy pattern) for SMART scope enhancement |
| **Microsoft Entra ID** | Azure customers; SMART Backend Services supported natively |
| **AWS Cognito** | Less mature SMART support; works for basic flows |
| **Ping Identity / ForgeRock** | Federal-leaning; native UDAP support — pairs with `udap_mode = delegate` |
| **Login.gov** | GSA-run; Kantara IAL2-accredited; OIDC-compliant; required by federal patient apps; Login.gov sandbox in CI |
| **id.me** | Commercial IAL2; CMS Medicare.gov beneficiary verification (2026 rollout); VA / IRS / SSA; OIDC-compliant; CI on-demand only (commercial gating) |
| **Custom OIDC** | Any OIDC-compliant IdP that supports the required claim set |

**IAL2 conformance is the IdP's responsibility, not Ronin's.** Ronin asserts that the OIDC IdP it accepts tokens from is IAL2-conformant per deployment configuration; the actual identity proofing lives at the IdP. CMS's interoperability framework accepts any "CMS-approved service for IAL2 or equivalent."

### 5. Scope enforcement — five-point shape

The TS App middleware enforces SMART scopes through five layered checks. Points 1–4 are owned by this ADR; point 5 is the cross-reference to ADR-0018.

1. **Token introspection + scope canonicalization.** RFC-7662 introspection on every request. Parses scope strings: v1 syntax (`patient/Coverage.read`) canonicalizes to v2 (`patient/Coverage.rs`). Result lands in the request context.
2. **Per-handler ops check.** FHIR REST handler checks the canonical scope's `.cruds` letters against the requested operation. `system/Patient.r` allows GET but not POST; `system/Patient.cruds` allows all five. Granular-restriction `?` parameters are extracted here.
3. **Granular query restriction injection.** When the scope carries `patient/Observation.rs?category=...vital-signs`, the restriction injects as a `WHERE` clause at the Bronze→Silver Governance + Gold read filter. Restriction is enforced *at the data path*, not just the access gate — a client cannot bypass it by reformulating their query.
4. **Patient compartment filter.** When the scope is `patient/X.rs` with `launch/patient` granted, the patient_id derived from `launch_context.patient` filters every read via the ADR-0010 §4 Patient compartment machinery. Resources outside the compartment return 403, not empty.
5. **Consent enforcement gate — see [ADR-0018](0018-patient-portal-consent-and-read-time-filter.md) §5.** After scope checks pass, ADR-0018's read-time filter evaluates active Consents against the requested resources using `meta.security` labels (populated by [ADR-0015 Amendment 2](0015-validation-architecture.md#amendment-2--security-labeling-service-sls)'s SLS), the requester's confidentiality clearance, and the claimed Purpose-of-Use. Excluded resources are dropped from the response; AuditEvent records the exclusion per ADR-0016 §2.1.1.

Points 1–4 run synchronously in the middleware. Point 5 evaluates in the read-side query layer because it operates over the actual data being returned, not just the request.

### 6. Token lifecycle defaults

All overridable per deployment via `ronin_*` variables:

| Setting | Default | Override variable | Notes |
|---|---|---|---|
| Access token TTL | **1 hour** | `ronin_access_token_ttl` | Industry standard; balances UX vs. stolen-token window |
| Refresh token TTL (`offline_access`) | **90 days** | `ronin_refresh_token_ttl` | Industry standard |
| Token introspection cache TTL | **60 seconds** | `ronin_introspection_cache_ttl` | Balances revocation propagation vs. introspection call volume |
| Revocation propagation | Cache invalidation at next request | n/a | OAuth event log `token_revoked` triggers immediate invalidation |
| Hard-revocation webhook | Optional | `ronin_revocation_webhook_enabled` | `/internal/token-revoke` endpoint accepts pushes from the customer's IdP for immediate effect |

### 7. Wildcard scope policy

| Profile | Default | Behavior |
|---|---|---|
| `payer_baseline` | **warn** | Wildcard scopes (`patient/*.rs`, `system/*.cruds`) allowed; OAuth event log captures a warning entry |
| `strict_federal` | **deny** | Wildcard scopes refused at token issuance; client receives `invalid_scope` |
| Override | `ronin_wildcard_scope_policy = allow | warn | deny` | Per-deployment |

### 8. IdP integration CI matrix

**In CI (v1 release gate):**

- Okta + Entra + custom OIDC reference IdP + Login.gov (Login.gov has a public sandbox; federal payer customers will require evidence of CI coverage).

**On-demand (deployment-time pilot):**

- id.me (commercial; CI integration requires customer-funded license).
- Ping Identity / ForgeRock (federal-leaning; added when customer demand surfaces).
- AWS Cognito (added when customer demand surfaces).

The matrix is documented in [ADR-0020 §4](0020-cicd-and-conformance-test-orchestration.md) under the CI/CD-test-targets section; this ADR establishes the floor.

### 9. UDAP trust bundle

| Source | Behavior |
|---|---|
| **DirectTrust UDAP community bundle** | Trusted by default; refreshed on the same cadence as ADR-0017's terminology refresh Job (operator-pulled per ADR-0017 §6 pattern) |
| **`ronin_udap_additional_cas`** | Per-deployment array of additional UDAP CAs for federal contracts requiring custom roots |
| **Activation flow** | Mirrors ADR-0017 §6: refresh Job materializes new CA versions; operator activates via `ronin udap activate-trust-bundle <version>`; prior version retained for rollback |

### 10. Granular-restriction audit posture

When a scope's `?category=...` restriction excludes results that would otherwise have matched:

- Resources are silently filtered from the response (no leak of "this resource existed").
- An OAuth event log entry records the restriction + the count of excluded resources per ADR-0016 §2.1.1.
- No client-facing `OperationOutcome` count — over-engineering for v1; revisit if customer demand surfaces.
- Per ADR-0018 §5, Consent-driven exclusions add a separate AuditEvent entry; the OAuth log and AuditEvent surfaces remain distinct.

### 11. EHR-launch context — per SMART App Launch 2.2.0

Ronin supports the SMART App Launch `launch` parameter end-to-end:

- Standalone Launch: app initiates OAuth; no `launch` parameter.
- EHR Launch (provider-side): EHR generates a launch token; app presents it; Ronin's `/authorize` exchanges it for context via the standard launch-context token endpoint extension. Context includes `patient`, `encounter`, `user`, `intent`, `tenant`.
- Patient-launch (payer patient portal): portal generates a launch token with `launch/patient`; same exchange flow.

Specific launch parameter content shapes per SMART spec; no Ronin extensions in v1.

### 12. CapabilityStatement security declarations

Per ADR-0014 §10, the CapabilityStatement publishes the auth surface at `/metadata`:

```
CapabilityStatement.rest[0].security.service[]:
  - {system: http://terminology.hl7.org/CodeSystem/restful-security-service, code: SMART-on-FHIR}
  - {system: http://terminology.hl7.org/CodeSystem/restful-security-service, code: OAuth}
  - {system: http://terminology.hl7.org/CodeSystem/restful-security-service, code: UDAP} (when udap_mode != off)

CapabilityStatement.rest[0].security.extension[]:
  - oauth-uris (SMART discovery URLs)
  - udap-uris (when udap_mode != off)
```

`/.well-known/smart-configuration` mirrors the SMART discovery; `/.well-known/udap` mirrors UDAP discovery. Generated from the same deployment configuration.

## Consequences

**What this commits Ronin to:**

- Single TS App deployment unit covers both SMART + UDAP surfaces (when `udap_mode = inline`); two deployment units when `udap_mode = delegate`.
- Both ICPs (Okta/Entra small-mid payer; Ping/ForgeRock federal-contract) supported at GA without a fork.
- TEFCA QHIN-participating payer customers can deploy on day one.
- CI requires two test kits: Inferno SMART App Launch + UDAP Test Tool. Both ratified by ADR-0014 §7.
- DirectTrust UDAP Certification path is available at GA for customers who need it as a procurement gate.

**What it costs:**

- Larger v1 GA scope than a SMART-only v1 would have been. Mitigated by reusing ADR-0017's refresh/activation pattern for the trust bundle and ADR-0013's bundle structure for the deployment unit.
- The IdP CI matrix is non-trivial (four IdPs). Mitigated by the in-CI list staying at four for v1; expansion is customer-driven.
- The five-point scope+consent enforcement adds one read-time check (point 5) that joins Consent state against `meta.security` on every read. Mitigated by ADR-0018's per-request lookup pattern (no caching) being O(1) per resource and ADR-0010's Patient compartment indexing already narrowing the result set.

## Alternatives considered

- **SMART-only v1; UDAP fast-follow v1.1** — rejected. SSRAA deadline already past; TEFCA-participating payer customers can't deploy a SMART-only Ronin.
- **UDAP gateway always inline** — rejected. Ping / ForgeRock customers have existing UDAP infrastructure; forcing them onto Ronin's inline gateway means rebuilding their trust posture and rejecting their existing CA relationships.
- **UDAP gateway always delegated** — rejected. Okta / Entra / Cognito customers don't have a UDAP gateway; forcing them to acquire one is an architecture-shaped sales blocker.
- **Ronin-hosted IdP** — rejected by ADR-0013 architecture; identity stewardship is the customer's responsibility.
- **Synchronous Consent check at token issuance** — rejected. Consent state changes between issuance and use; checking at the data path (point 5) catches revocations in real time. Token introspection cache TTL bounds the window.
- **DPoP / mTLS / Tiered OAuth in v1** — rejected. None are required by CMS-0057 or SSRAA 1.0.0; specs still evolving; v2+ candidates per the research note.
- **Patient consent as inline ADR-0006 concern** — rejected; the Consent surface is large enough to warrant ADR-0018; this ADR plugs into the gate via §5 point 5.

## Follow-up ADRs queued

- **ADR-0018: Patient Portal + Consent + Read-Time Filter** — owns the §5 point 5 gate.
- **ADR-0015 Amendment 2: Security Labeling Service** — the meta.security-label population the consent gate depends on.
- **TEFCA participation ADR** — including TEFCA Patient IAL2 workflow; cross-QHIN consent and audit surfaces.
- **Operability ADR** — CI/CD orchestration for the SMART + UDAP test kits; IdP test matrix details; trust bundle refresh choreography.
- **DPoP token binding** (v2+) — RFC 9449.
- **mTLS as a client authentication method** (v2+) — RFC 8705.
- **Tiered OAuth + OIDC Federation** (v2+) — TEFCA cross-org delegated authority chains.
- **Pediatric / minor patient scope policy** (v1.x or v2).
- **Resource-instance-level + operation-specific scopes** (SMART 2.3 / 2.4 territory).
- **Caregiver / proxy access flows** (v1.x; depends on customer demand).

## Open questions not closed by this ADR

- **Specific IdP integration test plans** — concrete CI orchestration details land in the Operability ADR.
- **Compliance-positioning UDAP narrative for customer-facing materials** — marketing concern, not architecture; lives in the GTM track.
- **Inferno + UDAP Test Tool CI orchestration** — same as above; Operability ADR.
- **Patient consent + cross-QHIN consent reconciliation** — when a patient grants consent in one QHIN context and a different-QHIN request lands, how is precedence resolved? Belongs in the TEFCA participation ADR.

## Sources

- [SMART App Launch v2.2.0](https://hl7.org/fhir/smart-app-launch/) — operation surface
- [SMART App Launch v2 Scopes and Launch Context](https://hl7.org/fhir/smart-app-launch/scopes-and-launch-context.html) — `.cruds` + granular restrictions
- [HL7 FHIR UDAP Security IG (SSRAA)](https://hl7.org/fhir/us/udap-security/index.html) — federal trust framework
- [UDAP.org Identity Assurance Levels](https://www.udap.org/udap-identity-assurance-levels) — IAL framework
- [UDAP Dynamic Client Registration STU 1](https://www.udap.org/udap-dynamic-client-registration-stu1.html) — DCR mechanics
- [TEFCA Facilitated FHIR SOP (Sequoia Project)](https://rce.sequoiaproject.org/wp-content/uploads/2025/10/SOP-Facilitated-FHIR-Implementation-2.0-Draft-October_508.pdf) — UDAP-in-TEFCA mechanics
- [DirectTrust UDAP Accreditation](https://accreditation.directtrust.org/programs/udap) — production certification path
- [UDAP Test Tool](https://www.udap.org/UDAPTestTool/) — conformance testing
- [Inferno SMART App Launch Test Kit](https://inferno.healthit.gov/test-kits/smart-app-launch/) — STU1 / STU2 / STU2.2
- [SMART on FHIR with Okta whitepaper](https://www.okta.com/resources/whitepapers/smart-on-fhir-with-okta/) — authorization proxy pattern
- [ID.me — CMS Medicare.gov contract](https://network.id.me/press-releases/id-me-announces-contract-with-cms-to-advance-access-security-and-user-experience-on-medicare-gov/) — federal IAL2 deployment
- [Login.gov IAL2-Compliant Identity Verification](https://login.gov/partners/program-updates/login-gov-now-offers-an-ial2-compliant-identity-verification-service/) — federal IAL2 alternative
- [CMS-0057-F factsheet](https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-prior-authorization-final-rule-cms-0057-f) — auth requirements per API
- [FAST Security now part of TEFCA and HTI-2 Requirements (HL7 blog)](https://blog.hl7.org/fast-security-now-part-of-tefca-and-hti-2-requirements) — SSRAA adoption deadline
- [docs/research/2026-06-19-smart-on-fhir-and-udap-landscape.md](../research/2026-06-19-smart-on-fhir-and-udap-landscape.md) — research note
