# fhirEngine — Security & Compliance Posture (OSS-Delta standalone)

_Applies to: fhirEngine (TS/Hono FHIR R4 server + delta-rs/DataFusion sidecar), self/cloud-hosted._
_Grounding: the 2026-07-03 [security deep-dive](../research/2026-07-03-tls-and-cms-compliance-security-deep-dive.md)
and ADR-0030..0036. This replaces the heritage Databricks-worded posture doc, which described
platform properties (Unity Catalog RBAC, platform-terminated TLS) that do NOT apply here._

> **Posture in one line:** the server ships the technical safeguards and FAILS CLOSED in
> production (ADR-0032); FIPS validation, encryption at rest, identity proofing, and the
> organizational HIPAA program are **operator/deployment properties** — documented here,
> never claimed by the software.

## HIPAA §164.312 technical-safeguards crosswalk

| Safeguard | fhirEngine control | Operator supplies |
|---|---|---|
| (a)(1) Access control | SMART scope enforcement (v1–v2.2 grammars) + consent/DS4P gate + patient-compartment restriction; `production` profile refuses to boot with auth off (ADR-0030/0032) | IdP (or use the built-in OAuth server with static keys); client registration |
| (b) Audit controls | AuditEvent per access **including denials** (audit mounted before the auth gate); accounting-of-disclosures via per-patient query; `production` requires audit on | Retention policy (HIPAA floor 6 yr); external anchor sink for chain tips |
| (c)(1) Integrity | Append-only versioned storage (Delta transaction log) + **hash-chained audit** with signed external anchoring (`fhirengine-audit-verify`, ADR-0035) | Filesystem/bucket permissions; anchor webhook endpoint |
| (d) Person/entity authentication | JWT verification with **pinned algorithm allow-list** (jwks/oidc/local strategies); SMART Backend Services (`private_key_jwt` + jti replay guard); UDAP B2B trust (X.509 + DCR + CRL/OCSP, ADR-0036) | IAL2/AAL2 identity proofing (IdP's job, SP 800-63) |
| (e)(1) Transmission security | Hardened in-process TLS: TLS 1.2 floor, SP 800-52r2 ECDHE+AES-GCM allow-list, HSTS + security headers, cert hot-reload (ADR-0031); proxy termination is the documented production default | TLS certs (ACME/PKI); FIPS-validated termination point if required |

## FIPS 140-3 posture (document, don't claim)

fhirEngine does **not** claim FIPS validation. Stock Node/OpenSSL builds are generally not
FIPS-validated modules. For federal/FIPS deployments: terminate TLS at a FIPS-validated
proxy/load-balancer (or run on a FIPS-validated OpenSSL platform), and use the shipped
cipher allow-list (AES-GCM only; ChaCha20 excluded). The at-rest story is likewise
operator-owned: cloud SSE-KMS, LUKS/dm-crypt, or filesystem encryption under the Delta base.

## Supply chain (NIST SA/SR)

Every push runs: CycloneDX SBOM generation, `npm audit` (high+), `pip-audit` (sidecar),
gitleaks (secrets), Trivy (vulnerabilities), plus image builds with a containerized boot
smoke (ADR-0034). Releases attach the SBOM to the GitHub Release and publish pinned images
to GHCR.

## Input handling

All search/query values reach DataFusion as **bound parameters**; range operators are
whitelisted at parse time; request bodies are capped (`FHIRENGINE_MAX_BODY_BYTES`);
request bodies/params are never logged (no access-log middleware; structured pino events
only). Regression: `tests/integration/delta-search-injection.test.ts`.

## What remains operator/organizational (never the server's claim)

- BAAs, risk analysis (§164.308), breach-notification process, workforce training.
- Encryption at rest; FIPS-validated crypto termination; key custody (KMS/HSM).
- Identity proofing (IAL2/AAL2) at the IdP; steward staffing for the MPI review queue.
- Data-segmentation labeling upstream (the server *enforces* DS4P labels, it does not tag).

## Known open items (tracked, honest)

- Full Inferno (g)(10) suite not yet run end-to-end (individual US Core groups pass; see
  `docs/standalone/inferno-g10-findings.md`).
- L5 profile/IG conformance validation is partial — the external HL7 validator remains
  authoritative for profile verdicts.
- EHR-launch (`launch` context exchange) is not wired in the standalone OAuth server
  (standalone launch + Backend Services are).
