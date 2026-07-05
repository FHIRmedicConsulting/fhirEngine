# TLS & CMS-Compliance Security Deep-Dive (gap analysis)

_Author: research/architecture pass · Date: 2026-07-03 · Applies to: **fhirEngine** (OSS-Delta FHIR R4 server, TS/Hono + Python delta-rs/DataFusion sidecar)_

> ## Implementation status (addendum, 2026-07-04/05)
>
> This analysis drove ADR-0031..0036 and subsequent patches. Roadmap (§7) status:
>
> | § | Item | Status |
> |---|---|---|
> | 1 | TLS hardening (T1/T2/T4/T5) | ✅ **ADR-0031** — TLS 1.2 floor, SP 800-52r2 cipher allow-list, HSTS, cert hot-reload |
> | 2 | Production fail-closed gate | ✅ **ADR-0032** — `FHIRENGINE_SECURITY_PROFILE=production` refuses to boot unless auth+audit+TLS configured |
> | 3 | Backend Services | ✅ implemented; Inferno end-to-end validation still **OPEN** |
> | 4 | HTTP hardening (X1/X2/X3) | ✅ **ADR-0033** — headers, enforced CORS, pluggable rate limiting, body caps. X5: no access-log middleware exists (bodies/params never logged) |
> | 5 | Conditional references (D1) | ✅ transactions resolve `Type?identifier=…` + `ifNoneExist` |
> | 6 | Bulk `$export` conformance (D2) | partial — async disk-backed `$export` shipped; Inferno Bulk suite **OPEN** |
> | 7 | Tamper evidence (B3/B4) | ✅ **ADR-0035** — hash-chained audit + signed external anchoring + `fhirengine-audit-verify` |
> | 8 | SBOM / dep-scan gate (X4) | ✅ **ADR-0034** — CycloneDX SBOM, npm-audit, pip-audit, gitleaks, Trivy in CI |
> | 9 | Da Vinci IGs + L5 (D4) | partial — PAS/CRD/DTR/HRex/EOB first slices shipped (see CHANGELOG); **L5 validation OPEN** |
> | 10 | UDAP/SSRAA (A3) | ✅ **ADR-0036** — X.509 trust, DCR, CRL/OCSP revocation, signed_metadata, tiered OAuth |
> | 11 | Port compliance docs | ✅ `docs/compliance/security-posture.md` (OSS-worded, 2026-07-05) |
> | — | A5 alg pinning at verify | ✅ 2026-07-05 patch — `algorithms` allow-list on all four `jwtVerify` sites (`FHIRENGINE_JWT_ALG` pins one) |
> | — | A4 refresh rotation | ✅ verified — refresh tokens are consumed on use (`takeRefresh` deletes) |
> | — | D3 injection defense | ✅ parameterized SQL + whitelisted range operators; regression `delta-search-injection.test.ts` (2026-07-05) |
> | — | Medallion/MPI (out of this doc's scope) | ✅ ADR-0026 + ADR-0012 v1 implemented 2026-07-04/05 |
>
> **Deep-audit follow-up (2026-07-05):** a full code-quality + vulnerability audit (4 review
> passes) hardened the remaining access-control surface — `$export`/`_history` scope gating +
> fail-closed `buildDataFilter`, cross-compartment write guard, export path-traversal
> validation, id-token/scopeless rejection, token-sourced Purpose-of-Use, consent-gated
> `_include`/history, SSRF guard on CRL/OCSP, and sidecar hardening (shared-secret token +
> path confinement). Correctness: MPI reference-rewrite corruption, POST-id invariant,
> cross-process write-version conflict detection, atomic conditional create.
>
> Remaining **OPEN**: full Inferno (g)(10) + Bulk Data suites end-to-end, L5 profile
> validation, EHR-launch context exchange (A1), default-on JWT audience enforcement (opt-in
> today via `FHIRENGINE_JWT_AUDIENCE`), DNS-rebinding IP-pinning on CRL/OCSP, and the OPER
> items (FIPS platform, at-rest encryption, key custody) in the compliance posture doc.

> **Scope note.** This is a *gap analysis of the server software* against the regulatory
> stack that governs a CMS-facing / ONC-certified FHIR R4 server. It grounds every control
> in what fhirEngine already has (citing the ADR / file) and states the gap +
> recommendation. It creates **no** new ADRs and changes **no** code — where a decision is
> implied, it is flagged as an **OPEN QUESTION** or a **recommended future ADR**, per the
> project's ADR-driven convention.
>
> **Full HIPAA compliance is NOT yet in scope** (BAAs, full administrative/physical
> safeguards, formal risk assessment per 45 CFR §164.308, breach-notification process,
> ATO / FedRAMP). Those are organizational/deployment obligations. This document is limited
> to **what the server software must do** to make that compliance *achievable* — and to what
> the operator/deployment must supply around it.
>
> **Legend for the "Owner" column in the tables:**
> **MUST** = required by cited regulation/standard for the certified/CMS use case ·
> **REC** = recommended best practice, not strictly mandated ·
> **OPER** = operator/deployment responsibility (server enables, doesn't own) ·
> **OUT** = out of fhirEngine scope (another app / org process).

---

## 0. TL;DR — the five biggest gaps

| # | Gap | Severity | Why it matters |
|---|-----|----------|----------------|
| 1 | **No FIPS/NIST-pinned TLS policy in-process** (Node defaults; no `minVersion`, no cipher list, no HSTS) | **High** | NIST SP 800-52r2 + ONC (g)(10)(viii) require TLS 1.2+ with FIPS-validated crypto; today the in-process HTTPS path ships whatever Node negotiates. |
| 2 | **No UDAP/SSRAA** in the standalone auth server. (SMART Backend Services — `client_credentials` + `private_key_jwt` — **IS implemented**: see `oauth/oauth-routes.ts` client_credentials branch + `delta-backend-services.test.ts`.) | **Medium** | Backend Services already covers Provider Access / Payer-to-Payer / Prior Auth / Bulk `$export` system auth; the remaining gap is **UDAP** (X.509 software statements + dynamic client registration), the TEFCA trust path — a larger, later surface. |
| 3 | **Security controls default OFF and enforcement is un-gated at deploy** (auth/audit/consent all opt-in) | **High** | Correct for synthetic dev, but there is no server-side *production deploy gate* that fails closed when PHI mode is on but `FHIRENGINE_AUTH_ENABLED` is false. |
| 4 | **No HTTP-tier hardening: rate limiting / DoS, CORS policy, security headers** | **Medium-High** | (g)(10) + HIPAA availability/OWASP expect these; `smart-configuration` advertises `cors:true` but no CORS is actually enforced. |
| 5 | **No SBOM / dependency-scan / supply-chain gate, and no ported standalone compliance mapping docs** | **Medium** | Component-disclosure policy + NIST SA family; the heritage `docs/compliance/*` are Databricks-worded and not carried into the standalone. |

Full detail and the ordered roadmap are in §7–§8.

---

## PART 1 — TLS IN DEPTH

### 1.1 What the regulations actually require

| Requirement | Standard / citation | Concrete spec |
|---|---|---|
| **TLS 1.2 mandatory; TLS 1.3 required** | NIST **SP 800-52 Rev 2** §3.1 | Servers *shall* support TLS 1.2; *should* support 1.3; federal systems were required to **support TLS 1.3 by Jan 1, 2024**. **SSL 2.0/3.0 and TLS 1.0/1.1 shall NOT be used.** |
| **FIPS-validated cryptographic module** | SP 800-52r2 §3.3 + **FIPS 140-3** (CMVP) | All algorithms in the negotiated cipher suites **and the RNG** must be within the boundary of a **FIPS 140-3 validated** module when processing federal data. (FIPS 140-2 validations are being sunset by CMVP; new work targets 140-3.) |
| **≥112 bits of security** | SP 800-52r2 §3.3 | Every algorithm used shall provide ≥112-bit strength (AES-128/256, SHA-256/384, RSA-2048+, ECC P-256/P-384). |
| **AEAD + PFS cipher suites** | SP 800-52r2 §3.3.1 | Prefer **ephemeral** key exchange (ECDHE > ECDH, DHE > DH) for perfect forward secrecy; prefer **AEAD** modes (GCM/CCM) over CBC. |
| **TLS 1.2 for the (g)(10) API** | 45 CFR **§170.315(g)(10)(viii)** + §170.404(a)(2) | Certified Health IT must **enforce TLS 1.2 or above**. **BCP 195** (RFC 9325) is *encouraged, not required*. |
| **TLS for the Bulk Data file server** | (g)(10) / SMART Bulk Data IG | The `$export` output file server must also enforce TLS 1.2+. |

**Concrete cipher suites (NIST SP 800-52r2-aligned, FIPS-approved):**

- **TLS 1.3** (fixed by the protocol; all are AEAD + PFS):
  `TLS_AES_128_GCM_SHA256`, `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`
  (ChaCha20-Poly1305 is *not* FIPS-approved — **omit it in a FIPS deployment**; keep the two AES-GCM suites).
- **TLS 1.2** (restrict to ECDHE + AES-GCM):
  `ECDHE-ECDSA-AES128-GCM-SHA256`, `ECDHE-ECDSA-AES256-GCM-SHA384`,
  `ECDHE-RSA-AES128-GCM-SHA256`, `ECDHE-RSA-AES256-GCM-SHA384`.
  (DHE-RSA-AES*-GCM suites are acceptable per 800-52r2 but slower; ECDHE preferred.)

**Certificate management (SP 800-52r2 §3.2 / §4):** server cert must be RSA-2048+ or ECDSA P-256/P-384, SHA-256+ signature, valid chain to a trusted CA, SAN populated (CN-only is deprecated), OCSP/CRL revocation checking available, and **automated renewal** (short-lived certs / ACME) to avoid expiry outages.

**HSTS:** `Strict-Transport-Security: max-age=31536000; includeSubDomains` — a **BCP 195 / OWASP recommendation** (not a NIST-800-52 *shall*), strongly advised for any PHI endpoint to prevent downgrade/stripping.

### 1.2 Where mTLS is (and isn't) required

Mutual TLS is a **client-authentication** mechanism, distinct from the transport encryption above. It is **not universally required**, but it appears in specific B2B trust paths:

| Context | mTLS status | Notes |
|---|---|---|
| Patient Access API (patient-facing SMART app) | **Not required** | Public/confidential OAuth client + PKCE; no client cert. |
| **UDAP** (SSRAA) for B2B / TEFCA | **Cert-based client identity** | UDAP uses **X.509 client certificates + signed software statements + `private_key_jwt`**. This is asymmetric-key client auth; it is *not* classic channel-mTLS, though some UDAP/TEFCA deployments layer mTLS at the transport too. |
| CMS-0057-F Provider Access / Payer-to-Payer / Prior Auth (system-to-system) | **SMART Backend Services** (`private_key_jwt`) is the floor; **UDAP** when the partner/QHIN requires it | CMS-0057-F / SSRAA 1.0.0 do **not** mandate channel-mTLS; UDAP's cert-bound client identity does the heavy lifting. |
| RFC 8705 **OAuth mTLS / certificate-bound tokens** | **Optional, v2+** | ADR-0006 explicitly defers DPoP (RFC 9449) and mTLS (RFC 8705) to v2+; neither is required by CMS-0057 or SSRAA 1.0.0 today. |

**Bottom line:** channel-mTLS is an **operator/deployment option** (often terminated at the proxy for specific B2B partners), *not* a blanket server requirement. The server-side work that *is* on the critical path is **`private_key_jwt` client authentication + JWKS-based client key resolution** (see §2.2), which UDAP builds on.

### 1.3 TLS — what fhirEngine has today

- **In-process HTTPS is supported but unopinionated.** `src/server.ts` reads `FHIRENGINE_TLS_CERT` / `FHIRENGINE_TLS_KEY` (PEM paths) and, if present, starts Node's `https` server via `@hono/node-server`; otherwise it serves plain HTTP and **logs a warning** referencing 45 CFR §164.312(e). It passes only `{cert, key}` — **no `minVersion`, no `ciphers`, no `honorCipherOrder`**, so the effective policy is **whatever the linked Node/OpenSSL negotiates** (modern Node defaults to TLS 1.2 floor, but the cipher list is not FIPS-restricted and TLS 1.0/1.1 posture depends on the build).
- **Proxy-termination is the documented default.** The server comment and Inferno findings both state TLS "terminates at the proxy in deployment"; the Inferno `standalone_auth_tls` test fails locally precisely because the local listener is plain HTTP (`docs/standalone/inferno-g10-findings.md`, Run 1 — flagged environmental).
- **Heritage posture doc** (`docs/compliance/security-posture.md`, Databricks-worded, *not* ported to `Ronin/docs`) asserts "TLS 1.3 … platform terminates TLS" — true for the Databricks product, **not** self-evidently true for a self-hosted standalone install.
- **No HSTS header, no security-header middleware** anywhere in `src/`.

### 1.4 TLS — gaps & recommendations

| # | Requirement | Have | Gap | Recommendation (Owner) |
|---|---|---|---|---|
| T1 | TLS 1.2 floor + 1.3, no legacy | In-process HTTPS with Node defaults | No explicit `minVersion:'TLSv1.2'`; legacy not provably disabled | Set `minVersion` (and where a FIPS build is used, `maxVersion`/cipher list) on the in-process server; document proxy config equivalent. **REC** (server) + **OPER** (proxy) |
| T2 | FIPS-approved cipher suites, ECDHE+AES-GCM | Unpinned | No cipher allow-list; ChaCha20 may be negotiated | Ship a documented cipher allow-list (§1.1) as an env-overridable default; note ChaCha20 exclusion for FIPS. **REC** (server) |
| T3 | FIPS 140-3 validated crypto module | Node/OpenSSL as built | Stock Node OpenSSL is generally **not** FIPS-validated | This is fundamentally **OPER**: run on a FIPS-validated OpenSSL / platform, *or* terminate TLS at a FIPS-validated proxy/load-balancer. Server should **document** the requirement and not claim FIPS itself. **OPER** |
| T4 | HSTS on PHI endpoints | none | No `Strict-Transport-Security` | Add HSTS via security-header middleware (see §6, control X3). **REC** (server) |
| T5 | Cert lifecycle / renewal | operator-supplied PEMs | No renewal story; expiry = outage | Document ACME/short-lived-cert pattern; server just needs reload-on-rotate (or proxy owns it). **OPER**, server **REC** to support cert reload |
| T6 | Bulk Data file server TLS | `$export` output path | Confirm `$export` file URLs are served over the same TLS-enforced origin | Ensure export file delivery inherits the TLS policy (same origin or signed-URL over TLS). **MUST** for (g)(10) |
| T7 | mTLS / UDAP cert-bound client auth | not implemented | No client-cert / `private_key_jwt` path | Sequence **after** Backend Services (§2.2); UDAP is a later, larger ADR. **OPEN QUESTION** on timing. |

---

## PART 2 — OVERALL FHIR-SERVER SECURITY FOR FULL CMS COMPLIANCE

### 2.1 The regulatory stack (what applies, and when)

| Rule / standard | What it is | Dates that matter | What it demands of a FHIR server |
|---|---|---|---|
| **CMS-9115-F** — Interoperability & Patient Access Final Rule (2020) | Foundational payer interop rule (MA, Medicaid/CHIP MCOs, QHPs on FFEs) | Published May 2020; **Patient Access + Provider Directory APIs enforced Jul 1, 2021** | **Patient Access API** (adjudicated claims/encounters + clinical, USCDI, back to service dates ≥ 2016), **Provider Directory API** (public, **no auth**), FHIR **R4 (4.0.1)**, US Core, SMART, CARIN BB, PDex, Plan-Net, Formulary IGs. |
| **CMS-0057-F** — Interoperability & Prior Authorization Final Rule | Published **2024-01-17**; extends CMS-9115-F | **Prior-auth *metrics/process* reporting begins Jan 1, 2026**; **all four APIs live Jan 1, 2027** (exact date varies by payer type) | (1) **Patient Access API** enhanced with **prior-auth data**; (2) **Provider Access API** (bulk, patient **opt-out**); (3) **Payer-to-Payer API** (patient **opt-in**); (4) **Prior Authorization API** (FHIR PAS, decision SLAs: 72h urgent / 7d non-urgent). |
| **ONC (g)(10)** — 45 CFR §170.315(g)(10) "Standardized API for patient and population services" | The certification criterion CMS rules lean on; tested by **Inferno** | Current | Single-patient (SMART App Launch) **and** multi-patient (**Bulk Data `$export`**) API; US Core; **TLS 1.2+ ((viii))**; token/refresh; app registration; documented API. |
| **US Core** | The USCDI-carrying profile set | Version per IG matrix (US Core 6.1.0 provisioned) | Profile conformance on read/search; must-support elements. |
| **SMART App Launch (incl. Backend Services)** | OAuth2/OIDC profile for FHIR | 2.0.0 floor (CMS-0057 adopted), 2.2.0 latest | Discovery, scopes (`.cruds` v2 grammar), PKCE S256, launch context; **Backend Services** = `client_credentials` + `private_key_jwt` for system flows. |
| **UDAP Security (SSRAA)** | Federal B2B trust framework (FAST Security) | **Adopted by TEFCA / referenced Jan 1, 2026** | X.509 client identity, signed software statement, Dynamic Client Registration (DCR), `private_key_jwt`, tiered OAuth. |
| **HL7 Da Vinci IGs** | PAS, CRD, DTR, PDex, HRex, Plan-Net, Formulary | Per CMS-0057 API | PAS drives Prior Auth API; PDex/HRex drive Provider Access & Payer-to-Payer; `$member-match` for payer matching. |
| **HIPAA Security Rule** — 45 CFR §164.312 | Technical safeguards for ePHI | In force | Access control, audit controls, integrity, person/entity authentication, transmission security (see §3). |
| **HITECH** | Breach notification + accounting of disclosures | In force | Server must support **accounting of disclosures** (queryable audit) + breach forensics. |
| **NIST** — SP 800-66r2 (HIPAA impl.), 800-53 (control families), 800-63 (identity/AAL), FIPS 140-3, SP 800-52r2 (TLS) | The engineering backbone under the above | Current | Maps each control to concrete engineering requirements (§3–§6). |

> **Regulatory-flux caveat (OPEN, track don't bake):** the ASTP/ONC **HTI-2** proposed rule
> (which had proposed **mandatory Dynamic Client Registration by Dec 31, 2027** and **SMART
> App Launch 2.2 by Jan 1, 2028**) was **largely unwound / proposed for withdrawal as of late
> December 2025**. Treat those specific certification deadlines as **not settled**. What is
> stable: CMS-0057-F's 2027 API dates, (g)(10)'s TLS 1.2+ requirement, and TEFCA's UDAP/SSRAA
> adoption. Do **not** design to withdrawn HTI-2 provisions without confirming scope.

### 2.2 Authentication & Authorization (OAuth2 / SMART / UDAP)

**Requirement.** (g)(10) + SMART App Launch: standalone & EHR launch, discovery
(`/.well-known/smart-configuration`), scope grammar (v2 `.cruds`), PKCE S256, refresh
tokens, and — for CMS-0057's system-to-system APIs — **SMART Backend Services**
(`client_credentials` grant + `private_key_jwt` client authentication + client JWKS).
UDAP/SSRAA adds DCR + X.509 client identity for TEFCA. Identity per NIST **SP 800-63**:
CMS-0057 patient apps typically **IAL2 + AAL2**, proofing done by the IdP.

**What fhirEngine has (ADR-0030, Accepted; heritage design ADR-0006):**
- **Auth gate** (`src/auth/`): `authMiddleware` + **`scope-enforcer`** with multi-version SMART parsing (1.0–2.2), opt-in `FHIRENGINE_AUTH_ENABLED`, strategy `stub|jwks|oidc` (`FHIRENGINE_AUTH_STRATEGY`). Identity/scopes derived **only** from verified token claims, never headers.
- **JWKS / local-JWT verification** (`src/auth/idp/jwks-auth.ts`, **jose**): verifies bearer JWT against `FHIRENGINE_JWKS_URI` (prod IdP) or `FHIRENGINE_JWT_PUBLIC_KEY` (dev SPKI/PEM); default alg ES256.
- **An in-process SMART authorization server** (`src/auth/oauth/`, opt-in `FHIRENGINE_OAUTH_ENABLED`): `authorization_code` + **PKCE S256**, `/oauth/token`, `/.well-known/jwks.json`, issues access/id/refresh JWTs the gate then verifies — "this server issues, our gate enforces."
- **Discovery**: `/.well-known/smart-configuration` + `/metadata` `rest.security` SMART service + `oauth-uris`; 401 + `WWW-Authenticate: Bearer` on protected routes; `/health` + `/metadata` public (`docs/standalone/inferno-g10-findings.md`).
- **Token lifecycle defaults** exist in ADR-0006 (1h access / 90d refresh / 60s introspection cache).

| # | Requirement (cite) | Have | Gap | Recommendation (Owner) |
|---|---|---|---|---|
| A1 | SMART App Launch standalone + EHR launch, PKCE, discovery (g)(10) | authorization_code + PKCE + discovery ✅ | EHR-launch (`launch` token exchange) present in heritage design (ADR-0006 §11) but confirm wired in standalone oauth server; interactive login is stubbed (auto-approve from config) | Confirm EHR-launch context exchange; a real login/consent UI is a portal concern. **MUST** for Patient Access; login UI **OPER/OUT** |
| A2 | **SMART Backend Services** (`client_credentials`+`private_key_jwt`) | **IMPLEMENTED** ✅ — `oauth/oauth-routes.ts` client_credentials branch verifies a `private_key_jwt` client assertion against the client's JWKS, enforces `jti` replay protection + audience, and issues a system-scoped token; covered by `delta-backend-services.test.ts`. (The module's old docstring said "follow-up" — stale; corrected.) | Covers Provider Access / Payer-to-Payer / Prior Auth / Bulk `$export` system auth | Verify against the Inferno SMART Backend Services suite end-to-end; confirm `system/*.rs` scope enforcement. **DONE** (validate via Inferno) |
| A3 | **UDAP / SSRAA** (DCR, X.509, tiered OAuth) | Not implemented in standalone (heritage ADR-0006 designs inline/delegate gateway) | No DCR, no software statement, no trust bundle in the standalone build | Sequence after A2; large surface → **recommend dedicated ADR**. **OPEN QUESTION** on timing vs. 2027. |
| A4 | Token security: short TTL, rotation, replay defense, `jti` | jti replay guard in `oauth/store.ts`; TTLs configurable | Verify refresh-token rotation + revocation propagation in standalone (heritage had webhook); key rotation for the signing key (`oauth/keys.ts`) | Document + test refresh rotation & signing-key rotation. **REC** |
| A5 | JWKS hygiene / alg pinning (no `alg:none`, no confusion) | jose with explicit `alg` (ES256 default) | Confirm alg allow-list is enforced on *verify* (reject `none`/HS when expecting ES/RS) | Pin accepted algs explicitly on verify. **MUST** (security) |
| A6 | IAL2/AAL2 identity (SP 800-63) | Trust IdP assertion (ADR-0006) | Correct division — server trusts IdP; no proofing | Keep; document that IAL/AAL is the IdP's job. **OPER** |
| A7 | Wildcard / granular scope policy | scope-enforcer + granular `?` restrictions (ADR-0006 §5) | Confirm granular restriction is enforced **at the data path** in the delta read layer (not just the gate) | Verify data-path enforcement in DataFusion read. **MUST** |

### 2.3 Audit logging & accounting of disclosures

**Requirement.** HIPAA §164.312(b) (audit controls) + HITECH accounting of disclosures +
FHIR AuditEvent. Every PHI access (and access *decision*, incl. denials) recorded, tamper-
evident, queryable per-patient, retained per mandate (HIPAA floor 6 yr).

**Have (ADR-0030 Phase 2 + ADR-0016 heritage):** heritage AuditEvent builder + middleware
adapted to an `AuditSink` interface; **`DeltaAuditSink`** (`src/audit/delta-audit-sink.ts`)
does serialized single-writer-safe appends; mounted **before** the auth gate so 401/403 are
also audited; `findByPatient` = accounting-of-disclosures. Opt-in `FHIRENGINE_AUDIT_ENABLED`.

| # | Requirement | Have | Gap | Recommendation (Owner) |
|---|---|---|---|---|
| B1 | AuditEvent on every access incl. denials | ✅ (audit before gate) | — | Keep; add coverage tests for the denial path. **MUST** ✅ |
| B2 | Accounting of disclosures (HITECH) | `findByPatient` | Confirm it captures cross-patient/system disclosures, not just single-patient reads | Verify accounting query completeness. **MUST** |
| B3 | Tamper evidence (§164.312(c)(1)) | Delta transaction log + (heritage) append-only + time-travel | Heritage relied on **Unity Catalog RBAC** (Databricks) — **not present in OSS Delta**; the standalone needs its own integrity story | Define OSS integrity: filesystem perms + append-only sink + optional hash-chain. **OPEN QUESTION → recommend ADR** |
| B4 | Retention (6/10/15 yr profiles) | Config pattern exists (heritage ADR-0016) | Confirm retention/vacuum honors audit retention in OSS Delta (`vacuum` could delete history) | Ensure audit tables are excluded from aggressive vacuum. **MUST/OPER** |
| B5 | No PHI in audit keys/paths | Heritage: UUID ids, hashed residual PHI | Confirm standalone keeps PHI out of audit indices/log lines | Verify logging hygiene (see §6 X5). **MUST** |

### 2.4 Consent & data segmentation (DS4P / 42 CFR Part 2)

**Requirement.** CMS-0057 patient opt-out (Provider Access) / opt-in (Payer-to-Payer) via
FHIR **Consent**; DS4P `meta.security` label enforcement; **42 CFR Part 2** SUD
redisclosure controls (2024 Final Rule single-consent TPO, enforced **2026-02-16**).

**Have (ADR-0030 Phases 3/3b/4):** read-time **consent-enforce** (`src/auth/consent-enforce.ts`)
— HCS confidentiality (U/L/M/N/R/V) + sensitivity (ETH/PSY/HIV/SUD…) + scope-context policy;
**computable-consent override** (loads active `Consent`, grants on a matching `permit`
provision); **obligations/redaction** (`src/auth/redact.ts`) — **42 CFR Part 2 `NORDSCLCD`
redisclosure notice** + element-level inline-label masking (`data-absent-reason`). Search/
`$everything` filtering counts only visible resources (no hidden-record leak). The server
**enforces but does not tag** — labeling + Bronze→Silver/Gold segmentation is the **external
governance/ELT app** (correct division per ADR-0030).

| # | Requirement | Have | Gap | Recommendation (Owner) |
|---|---|---|---|---|
| C1 | FHIR Consent opt-in/opt-out (CMS-0057) | consent read-time engine ✅ | Confirm the **write/lifecycle** of Consent (portal or `/Consent` REST) + opt-out default semantics per API | Wire opt-out-default vs opt-in-default per API. **MUST** (portal UI = **OPER/OUT**) |
| C2 | DS4P label enforcement | ✅ confidentiality/sensitivity/obligations | Depends on **upstream labels existing** (the ELT app) | Keep enforce-not-tag boundary; document the trust dependency. **MUST** (server) / labeling **OUT** |
| C3 | 42 CFR Part 2 redisclosure | `NORDSCLCD` stamp ✅ | Confirm single-consent-TPO alignment (2024 rule) | Validate against 2024 Part 2 model. **MUST** |
| C4 | Segmentation integrity (labels trusted) | enforce-not-tag | Label producer is the trust root; needs integrity protection upstream | Document integrity boundary (NIST SA). **OUT** (server documents dependency) |

### 2.5 FHIR surface, validation, input handling

**Requirement.** (g)(10)/US Core conformance; safe parsing; injection defense; bounded input.

**Have:** REST surface complete (session 032 — CRUD, history/vread, search, `$everything`,
`$export`, batch/transaction, conditional ops); validation chain L1/L2 structural + L3
terminology + L4 FHIRPath + slicing + installed-profile required-elements, **prior to Bronze**,
resource-level dead-letter; Inferno (g)(10) harness operational with US Core 6.1.0 Patient +
clinical groups largely passing (`docs/standalone/inferno-g10-findings.md`).

| # | Requirement | Have | Gap | Recommendation (Owner) |
|---|---|---|---|---|
| D1 | US Core profile conformance (g)(10) | Passing many groups | **Conditional-reference resolution** in transactions (Synthea `Type?identifier=…` not resolved) — real gap noted in Inferno Run 4 | Implement conditional-reference + org/practitioner preload. **MUST** for full US Core |
| D2 | Bulk Data `$export` conformance | `$export` present | Confirm async status, `_type`/`_since`, TLS'd file delivery, Backend-Services-gated | Run Inferno Bulk Data suite; gate behind A2. **MUST** |
| D3 | Input validation / injection | Parameterized reads; validation chain | Confirm search param + FHIRPath inputs can't inject into DataFusion SQL; bound bundle depth/size | Add SQL-injection + resource-bomb tests. **MUST** (OWASP) |
| D4 | Full-IG (L5) profile validation | `PROFILE_VALIDATORS` hook (todo) | L5 conformance validation still to build | Per `server-priorities`: after full compliance, before Inferno gate. **REC/MUST** for Da Vinci IGs |

### 2.6 Encryption at rest & secrets

**Requirement.** HIPAA §164.312(a)(2)(iv) (addressable encryption); NIST — encrypt ePHI at
rest with FIPS-validated crypto; secrets never in repo/logs.

**Have:** Secrets via **1Password `op run`** only (`docs/security/secrets.md`, memory
`secrets-1password`); PHI-clean policy (no PHI in logs/memory/scratchpad/commits).

| # | Requirement | Have | Gap | Recommendation (Owner) |
|---|---|---|---|---|
| E1 | Encryption at rest (FIPS) | — | OSS Delta files on disk are **not** app-encrypted; heritage relied on cloud SSE (S3/ADLS/GCS) | Self-host at-rest encryption is **OPER** (LUKS/dm-crypt, cloud SSE-KMS, or FS-level). Server documents requirement. **OPER** |
| E2 | Secrets management | 1Password `op run` ✅ | Runtime secret injection story for containers/prod (env vs mounted) | Document prod secret injection (K8s secrets / vault). **REC/OPER** |
| E3 | Signing-key protection (`oauth/keys.ts`) | keys in process | Where are private signing keys stored/rotated in prod? | Document key custody (KMS/HSM optional). **REC** |

---

## PART 3 — HIPAA §164.312 technical-safeguards crosswalk

| §164.312 safeguard | Requirement | fhirEngine status | Gap / Owner |
|---|---|---|---|
| (a)(1) **Access control** — unique user ID, emergency access, auto-logoff, encryption | Scope+consent+compartment enforcement | Five-point gate (ADR-0006/0018/0030) ✅ (opt-in) | Deploy-gate to force-on in PHI mode (**High**, §7) |
| (b) **Audit controls** | Hardware/software audit mechanisms | DeltaAuditSink ✅ | Tamper evidence in OSS Delta (B3) |
| (c)(1) **Integrity** — protect ePHI from improper alteration/destruction | Versioning/provenance | Delta txn log + ADR-0010 provenance | OSS tamper-evidence story (B3) — **OPEN** |
| (d) **Person/entity authentication** | Verify identity before access | JWKS/JWT + IdP trust (IAL2/AAL2) ✅ | Backend Services + UDAP (A2/A3) |
| (e)(1) **Transmission security** — integrity + encryption in transit | TLS | In-process HTTPS + proxy pattern; **unpinned** | TLS policy hardening (Part 1) |
| §164.308(a)(1)(ii)(A) **Risk analysis** (admin) | Formal risk assessment | — | **Out of server scope**; org obligation (noted) |
| §164.404 **Breach notification** | Detection + forensics | Heritage breach patterns (Databricks-worded) | Port detection to OSS; process = **OUT/OPER** |

---

## PART 4 — NIST underpinnings (mapping)

- **SP 800-66r2** (implementing HIPAA Security Rule): the crosswalk in Part 3 is the artifact
  800-66r2 expects; the *organizational* risk-management program around it is out of scope.
- **SP 800-53** control families most load-bearing here: **AC** (access control → §2.2/2.4),
  **AU** (audit → §2.3), **IA** (identification/authentication → §2.2), **SC** (system &
  comms protection → TLS/at-rest, Part 1/§2.6), **SI** (system integrity → §2.5/B3),
  **SA/SR** (supply chain → §6 X4). fhirEngine touches AC/AU/IA/SC; SA/SR is the
  weakest (no SBOM gate).
- **SP 800-63** (IAL/AAL/FAL): IdP-owned; server trusts asserted assurance (A6). CMS-0057
  patient apps → IAL2/AAL2 typical.
- **FIPS 140-3**: TLS + at-rest crypto must run in validated modules → **OPER** (platform/
  proxy), documented not claimed (T3/E1).
- **SP 800-52r2**: the TLS policy in Part 1.

---

## PART 5 — CMS-0057-F API readiness scorecard

| API (CMS-0057-F, live 2027-01-01) | Auth needed | Server building blocks present | Blocking gap |
|---|---|---|---|
| **Patient Access** (+prior-auth data) | SMART App Launch (user) | authorization_code+PKCE, US Core, search, `$everything` | Add prior-auth (PAS) data surface; EHR/portal login (OPER) |
| **Provider Access** (bulk, opt-out) | **Backend Services** + (UDAP for TEFCA) | Bulk `$export`, consent opt-out engine | **A2 (Backend Services)**, PDex IG, opt-out-default wiring |
| **Payer-to-Payer** (opt-in) | Backend Services + `$member-match` | consent opt-in engine | **A2**, `$member-match`, HRex, MPI (`$match` heritage) |
| **Prior Authorization** (PAS) | Backend Services | REST + transaction | **A2**, Da Vinci **PAS/CRD/DTR** IGs (L5 validation D4) |
| **Provider Directory / Formulary** | **none (public)** | REST read | Plan-Net / Formulary IGs; ensure public-read path bypasses auth cleanly |

---

## PART 6 — Cross-cutting technical controls (HTTP tier + supply chain)

| # | Control | Requirement | Have | Gap | Recommendation (Owner) |
|---|---|---|---|---|---|
| X1 | **Rate limiting / DoS** | HIPAA availability; OWASP API4; breach-throttle | Heritage breach patterns (Databricks) | **No rate limiting in standalone `src/`** | Add per-client/token rate limiting + backpressure. **REC → recommend ADR** |
| X2 | **CORS policy** | Browser SMART apps need correct CORS; over-permissive = risk | `smart-configuration` advertises `cors:true` but **no CORS middleware enforces it** | Advertised ≠ implemented | Implement an explicit, configurable CORS allow-list. **MUST** (SMART browser apps) |
| X3 | **Security headers** | HSTS, `X-Content-Type-Options`, `X-Frame-Options`/CSP, no server banner | none in `src/` | Missing | Add a security-header middleware (Hono). **REC** |
| X4 | **SBOM / supply chain** | Component-disclosure policy; NIST SA/SR; SBOM | Deps pinned in `package.json`; policy doc exists | **No SBOM generation, no dep-scan CI gate** in standalone | Add SBOM (CycloneDX/SPDX) + `npm audit`/Grype + `pip-audit` for the Python sidecar in CI. **REC → gate** |
| X5 | **Logging hygiene (no PHI)** | Project non-negotiable; HIPAA | pino; PHI-clean policy; UUID ids | Needs an automated check that request bodies/params aren't logged | Add a log-scrubber + test; keep bodies out of `pino` at info. **MUST** |
| X6 | **Un-ratified components** | Component-disclosure policy | Hono, heritage `src/auth/`, jose (approved) flagged | Hono/TS stack + heritage auth still **un-ratified** (ADR-0002 Rejected, no replacement) | Ratify the runtime + heritage-auth reuse (ADR-0029 covers stack; auth needs sign-off). **REC** |

---

## PART 7 — Prioritized gap-closure roadmap

Ordered by (blocking-for-compliance × severity), respecting `server-priorities`
(full compliance → profile/IG install → Inferno) and `write-first-defer-query-engine`.

1. **TLS policy hardening (Part 1, T1/T2/T4/T6).** Pin `minVersion:'TLSv1.2'` + FIPS cipher
   allow-list + HSTS on the in-process path; document the proxy-equivalent and the
   FIPS-140-3 platform requirement (T3). *Fast, unblocks the Inferno `standalone_auth_tls`
   check and satisfies (g)(10)(viii).* **[High, small]**
2. **Production deploy-gate / fail-closed (Gap #3).** When a PHI/production flag is set,
   the server must refuse to start (or refuse PHI routes) unless auth+audit+consent are
   enabled. Turns "opt-in default off" into "provably on in prod." **[High, small-med]**
3. ~~SMART Backend Services (A2)~~ **DONE** — `client_credentials` + `private_key_jwt` + client
   JWKS is implemented (`oauth/oauth-routes.ts`, `delta-backend-services.test.ts`). Remaining:
   validate end-to-end against the Inferno SMART Backend Services suite. **[verify only]**
4. **HTTP-tier hardening (X2 CORS, X1 rate-limit, X3 headers, X5 log-scrub).** **[Med, med]**
5. **Conditional-reference resolution in transactions (D1)** — real US Core / Inferno gap.
   **[Med, med]**
6. **Bulk Data `$export` conformance pass (D2)** once A2 lands (Inferno Bulk Data suite).
   **[Med, med]**
7. **OSS-Delta tamper-evidence + audit-retention integrity (B3/B4)** — replace the
   Databricks-UC assumption with an OSS story. Recommend ADR. **[Med, med]**
8. **SBOM + dependency-scan CI gate (X4)**, incl. the Python sidecar. **[Med, small-med]**
9. **Da Vinci IGs + L5 profile validation (D4)** for PAS/CRD/DTR/PDex/HRex — the IG-install
   phase. **[Med, large]**
10. **UDAP / SSRAA (A3)** — DCR, X.509, trust bundle; dedicated ADR; sequence toward 2027 /
    TEFCA need. **[High-value, large, later]**
11. **Port + rewrite the compliance docs** (`docs/compliance/*`) for the OSS-Delta reality
    (they are currently Databricks-worded and live only at the repo root, not in `Ronin/`).
    **[Low-effort, high-clarity]**

---

## PART 8 — TLS decisions needed (feeds the parallel hands-on TLS work)

These are **decisions to make now**, framed as options — not decisions taken here.

1. **Terminate TLS in-process vs. at a proxy — for which deployment tier?**
   - *Recommendation:* **both, explicitly.** Keep the in-process HTTPS path (already coded)
     as the **dev/single-node** story, hardened per Part 1; make **reverse-proxy /
     load-balancer termination** (nginx/Envoy/cloud LB) the **documented production default**
     because that is where FIPS-validated crypto (T3), cert automation (T5), HSTS, and
     rate-limiting most naturally live. **OPEN QUESTION:** is a hardened in-process TLS a
     supported *production* mode, or dev-only?
2. **Cert strategy: local/dev vs. prod.**
   - *Dev:* self-signed / `mkcert` local CA (so `FHIRENGINE_TLS_CERT/KEY` works and Inferno's TLS
     check passes locally). *Prod:* **ACME / short-lived certs** (or operator-supplied from
     their PKI) terminated at the proxy. Server needs, at most, **cert hot-reload** support.
     **OPEN QUESTION:** does fhirEngine ship any cert tooling, or is it 100% operator-
     supplied with docs only? (Leaning: docs + example configs only, to stay unopinionated.)
3. **FIPS 140-3 posture.**
   - *Decision needed:* the server should **document, not claim** FIPS — validated crypto is
     an **OPER** property of the OpenSSL/platform/proxy. Confirm we won't attempt a
     FIPS-Node build in-tree.
4. **Cipher/version defaults to ship.**
   - Adopt the §1.1 allow-list (TLS 1.2 floor + 1.3; ECDHE+AES-GCM; **exclude ChaCha20 for
     FIPS**), env-overridable. Confirm we're comfortable making these the shipped defaults.
5. **mTLS / UDAP timing (ties to A2/A3).**
   - *Decision needed:* **Backend Services (`private_key_jwt`) first**; channel-mTLS and full
     UDAP cert-bound identity are **later** and likely **proxy-terminated for named B2B
     partners**. **OPEN QUESTION:** do any near-term pilots require UDAP before 2027, or can
     it follow Backend Services?
6. **HSTS + security headers ownership.**
   - Decide whether HSTS/headers are emitted **in-process** (portable, works behind any
     proxy) or delegated to the proxy. *Recommendation:* emit in-process (X3) so the guarantee
     travels with the app, and let the proxy add/override.

---

### Sources (regulatory + standards)

- NIST SP 800-52 Rev. 2 — <https://csrc.nist.gov/pubs/sp/800/52/r2/final> · PDF <https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-52r2.pdf>
- TLS standards compliance overview (cipher suites) — <https://www.ssl.com/guide/tls-standards-compliance/>
- ONC (g)(10) API criterion + TLS 1.2 guidance — <https://onc-healthit.github.io/api-resource-guide/g10-criterion/> · <https://www.healthit.gov/test-method/standardized-api-patient-and-population-services>
- 45 CFR §170.315 — <https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-D/part-170/subpart-C/section-170.315>
- CMS-0057-F (Interoperability & Prior Authorization Final Rule) — <https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-prior-authorization-final-rule-cms-0057-f> · rule PDF <https://www.cms.gov/files/document/cms-0057-f.pdf>
- CMS-9115-F (Interoperability & Patient Access Final Rule) — <https://www.cms.gov/priorities/burden-reduction/overview/interoperability/policies-regulations/cms-interoperability-patient-access-final-rule-cms-9115-f>
- HL7 UDAP Security IG (SSRAA) — <https://hl7.org/fhir/us/udap-security/index.html>
- ASTP/ONC HTI-2 status (largely unwound Dec 2025) — <https://www.hklaw.com/en/insights/publications/2026/01/astp-oncs-year-end-moves-mark-a-strategic-pivot>
- FAST Security in TEFCA/HTI-2 — <https://blog.hl7.org/fast-security-now-part-of-tefca-and-hti-2-requirements>

### Internal grounding (this repo)

- ADR-0030 (standalone security/privacy/consent enforcement — Accepted) · ADR-0006 (SMART/UDAP) · ADR-0016 (audit) · ADR-0018 (consent) · ADR-0010 (integrity) · ADR-0029 (runtime/stack)
- `packages/server/src/server.ts` (TLS), `src/auth/` (gate, scope-enforcer, jwks-auth, oauth/, consent-enforce, redact), `src/audit/delta-audit-sink.ts`
- `docs/standalone/inferno-g10-findings.md` · `docs/security/secrets.md` · root `docs/compliance/*` (heritage, Databricks-worded — not yet ported)
- `Research_report_FHIR_Privacy_Security_and_Consent.md` · `CLAUDE.md` · project memory `MEMORY.md`
