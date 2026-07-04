# ADR-0036: UDAP B2B Trust — Software Statements & Trusted Dynamic Client Registration (foundation)

- Status: **Accepted** 2026-07-04 (Chad — Scope-1 deferred items; foundation, not the full SSRAA surface)
- Date: 2026-07-04
- Decider(s): Chad
- Session: standalone security hardening (Scope-1 deferred items)
- Related: [ADR-0006](0006-smart-on-fhir-and-udap-security.md) (SMART/UDAP heritage design), [ADR-0030](0030-standalone-security-privacy-consent-enforcement.md), [ADR-0032](0032-production-security-profile.md), `docs/research/2026-07-03-tls-and-cms-compliance-security-deep-dive.md` (gap A3)

## Context

CMS-0057-F's B2B APIs (Provider Access, Payer-to-Payer, Prior Auth) and TEFCA use **UDAP/SSRAA** for
system-to-system trust: a partner proves identity with an **X.509 certificate** chained to a trusted
CA, presents a signed **software statement** to a **Dynamic Client Registration** endpoint, then
authenticates with that certificate. The standalone had SMART Backend Services (`private_key_jwt`)
but no certificate-based trust or DCR — gap **A3** in the security deep-dive.

## Decision

Add a UDAP **foundation** (opt-in `RONIN_UDAP_ENABLED`, `RONIN_UDAP_TRUST_ANCHORS`), in
`src/auth/udap/`, **no new dependency** (Node `crypto.X509Certificate` + existing `jose`):

- **`trust.ts`** — load trust anchors (PEM); `verifyCertChain(x5c, anchors)` validates leaf→…→anchor
  linkage (issuer signature) + validity windows, terminating at a trusted CA.
- **`software-statement.ts`** — `verifySoftwareStatement`: verify the `x5c` chain, verify the JWT under
  the leaf cert key, check `iss === sub` and `aud === registration endpoint`; derive the client's
  token-signing **JWKS from the leaf cert** (UDAP clients authenticate with the same cert).
- **`udap-routes.ts`** — `GET /.well-known/udap` (server metadata) + `POST /udap/register` (Trusted
  DCR). A registered client is stored (`registered-clients.ts`) and resolved by `oauth/clients.ts`, so
  it immediately works at the existing `/oauth/token` via `private_key_jwt` / Backend Services.

## Consequences

- (+) Certificate-rooted B2B trust + DCR — the on-ramp to CMS-0057 B2B / TEFCA; reuses the Backend
  Services token path. Tested against real openssl-minted CA/leaf certs.
- (+) **Revocation implemented** (operator revocation list): `RONIN_UDAP_REVOKED_CERTS` /
  `RONIN_UDAP_REVOKED_CERTS_FILE` (cert SHA-256 fingerprints and/or serials). A revoked cert anywhere
  in a presented chain rejects the whole chain — so a compromised partner cert can be revoked
  immediately, without waiting for expiry. No new dependency.
- (+) **Persistent client registry** — DCR registrations are written through to a durable `udap_client`
  Delta table (`registered-clients.ts` + catalog/warehouse), loaded into the in-memory cache on
  startup, so registrations survive restarts and repopulate a fleet (latest-per-client_id wins).
- (+) **Signed discovery** (`signed_metadata` at `.well-known/udap`) + **tiered OAuth** — `/oauth/authorize`
  accepts a signed **request object (RFC 9101 JAR)** verified against the client's registered key, so the
  authorization request is provably from the client.
- (−) **Not complete SSRAA yet.** Deferred (**OPEN QUESTIONS / follow-ups**):
  - ~~Live CRL/OCSP~~ **DONE** (2026-07-04; `pkijs`+`asn1js` approved). **CRL** (`crl.ts`): downloads the
    cert's CRL Distribution Point (or `RONIN_UDAP_CRL_URLS`), **verifies the CRL is signed by a trusted
    issuer**, checks the serial, caches per `nextUpdate` (`RONIN_UDAP_CRL_CHECK`). **OCSP** (`ocsp.ts`,
    RFC 6960): queries the responder from the cert's AIA (or `RONIN_UDAP_OCSP_URLS`), pkijs builds the
    request and **verifies the signed response** (`RONIN_UDAP_OCSP_CHECK`). Both soft-fail by default
    (`*_HARD_FAIL` to fail closed) and are enforced in `verifySoftwareStatement`.
  - ~~RFC 5280 path validation + name-constraints~~ **DONE** (2026-07-04): `path-validation.ts` enforces
    **basic constraints** (CA flag + pathLen), **key usage** (keyCertSign on CAs), and **name
    constraints** (permitted/excluded dNSName/URI/rfc822 subtrees) over the full leaf→root path. On by
    default (`RONIN_UDAP_STRICT_PATH`, `false` to disable); fail-closed. NB: pkijs'
    `CertificateChainValidationEngine` does **not** reliably enforce name constraints (verified — it
    accepted an out-of-subtree leaf), so name-constraint matching is implemented directly; pkijs is used
    only to parse the extensions.
  - Remaining: UDAP **certifications/endorsements** and community/**trust-bundle** management; policy
    constraints / certificate-policies processing (RFC 5280 §6.1.3–4 full). Post-alpha.
