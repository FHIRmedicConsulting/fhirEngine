# ADR-0033: HTTP-Tier Hardening (headers, CORS, rate limiting, body limits)

- Status: **Accepted** 2026-07-04 (Chad — "mark the ADRs approved")
- Date: 2026-07-04
- Decider(s): Chad
- Session: standalone security hardening
- Related: [ADR-0030](0030-standalone-security-privacy-consent-enforcement.md), [ADR-0032](0032-production-security-profile.md), `docs/research/2026-07-03-tls-and-cms-compliance-security-deep-dive.md`

## Context

The delta app had no HTTP-tier defenses: no security response headers, no rate limiting / DoS
protection, no request-size cap, and the SMART `smart-configuration` advertised `cors:true` while
**no CORS was actually enforced**. (g)(10) + HIPAA availability + OWASP API hardening expect these.

## Decision

`src/security/http-hardening.ts` mounts, **first in the middleware chain** (so it also covers auth
denials), using **Hono built-ins only (no new dependency)**:

1. **Security headers** (`hono/secure-headers`): HSTS `max-age=31536000; includeSubDomains`,
   `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a
   strict CSP for a JSON API (`default-src 'none'; frame-ancestors 'none'`), COOP/CORP, and
   `Cache-Control: no-store` so PHI is never cached (§164.312(e)).
2. **CORS** (`hono/cors`) — actually enforced: allowlist from `RONIN_CORS_ORIGINS`. Production with
   no allowlist emits **no** CORS headers (same-origin only); dev with none is permissive so
   conformance/test tooling is unaffected.
3. **Body size limit** (`hono/body-limit`): default 10 MiB (`RONIN_MAX_BODY_BYTES`) → 413 when
   exceeded.
4. **Rate limiting** (`src/security/rate-limit.ts`): fixed-window, keyed by authenticated
   `client_id` else client IP; emits `RateLimit-*` + `Retry-After`; 429 on breach. **On** in the
   production profile (default 600/client/min, `RONIN_RATE_LIMIT_RPM`), **off** in dev by default so
   high-volume test runs aren't throttled.

## Consequences

- (+) Standard API hardening; non-breaking defaults (headers harmless, CORS permissive in dev,
  rate-limit off in dev) — verified against the full unit + delta suites.
- (−) The default rate-limit store is **single-node** (per-process counters). The limiter is now
  **store-pluggable** (`RateLimitStore`, async-capable) so a shared store (e.g. Redis) can make limits
  consistent across instances — the shared-store *implementation* is a follow-up (would add a Redis
  dependency → its own disclosure/ADR). Single-node is fine for Alpha and as a per-instance backstop
  behind an LB.
