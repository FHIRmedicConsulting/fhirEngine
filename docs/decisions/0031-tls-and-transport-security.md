# ADR-0031: TLS & Transport Security Policy

- Status: **Accepted** 2026-07-04 (Chad — "mark the ADRs approved")
- Date: 2026-07-04
- Decider(s): Chad
- Session: standalone security hardening
- Related: [ADR-0030](0030-standalone-security-privacy-consent-enforcement.md), [ADR-0032](0032-production-security-profile.md), [[phi-security-standards]], `docs/research/2026-07-03-tls-and-cms-compliance-security-deep-dive.md`

## Context

Transmission security (45 CFR §164.312(e)(1)) and ONC (g)(10)(viii) require TLS 1.2+ with
FIPS-validated crypto; NIST SP 800-52r2 pins versions and cipher suites. The prior `server.ts`
started Node HTTPS from `RONIN_TLS_CERT/KEY` with **no** `minVersion`, cipher allow-list, or
protocol-downgrade protection — it shipped whatever Node negotiated.

## Decision

1. **In-process HTTPS is hardened** (`src/security/tls.ts`): `minVersion=TLSv1.2`,
   `maxVersion=TLSv1.3`, `honorCipherOrder=true`, obsolete protocols disabled at the OpenSSL layer
   (`SSL_OP_NO_SSLv2/v3/TLSv1/TLSv1_1`), and an AEAD-only ECDHE cipher allow-list
   (`NIST_TLS12_CIPHERS`) that **excludes ChaCha20-Poly1305** (not FIPS 140-3 approved). Overridable
   via `RONIN_TLS_CIPHERS`.
2. **FIPS 140-3 is a platform property, not a code claim.** The server pins the *policy*; the
   operator supplies a FIPS-validated crypto module (OpenSSL FIPS provider / OS) and certificates.
   We **document, not claim** FIPS.
3. **Two supported termination models:** (a) hardened in-process HTTPS (dev / single-node); (b) TLS
   terminated at a reverse proxy / load balancer — **the documented production default**. The
   production profile (ADR-0032) requires one or the other (`RONIN_TLS_TERMINATED_AT_PROXY=true`
   attests the proxy case).
4. **HSTS** is emitted by the HTTP hardening layer (ADR-0033).

## Consequences

- (+) Meets SP 800-52r2 / (g)(10)(viii) baseline; unblocks Inferno `standalone_auth_tls` when run
  over TLS. (+) No new dependency (Node stdlib `tls`/`https`).
- (+) **Cert hot-reload implemented** (`watchTlsCert`, wired in `server.ts`): watches the cert/key
  directories and calls `server.setSecureContext(...)` on an ACME/cert-manager renewal — no restart,
  new connections pick up the new cert. Bad/partial writes keep the previous context.
- (−) Certificate *issuance/rotation* (ACME client) remains a deployment concern — dev uses static
  self-signed / mkcert; prod is expected to use proxy- or cert-manager-managed certs. In-process ACME
  is out of scope.
- mTLS / UDAP channel security is out of scope here (later ADR).
