# ADR-0032: Production Security Profile & Fail-Closed Enforcement

- Status: **Accepted** 2026-07-04 (Chad — "mark the ADRs approved")
- Date: 2026-07-04
- Decider(s): Chad
- Session: standalone security hardening
- Related: [ADR-0030](0030-standalone-security-privacy-consent-enforcement.md), [ADR-0031](0031-tls-and-transport-security.md), [[phi-security-standards]]

## Context

Per ADR-0030 the PHI controls (auth, audit, consent) are **opt-in and OFF by default** — correct
for synthetic dev/conformance, dangerous as a *production* default. Nothing stopped an operator from
exposing PHI with the gate off. HIPAA §164.312 (access control, audit, transmission security) and
NIST SP 800-53 (AC/AU/SC) require these to be *on* in production; the software should make that
provable rather than trusting operator discipline.

## Decision

Introduce an explicit **security profile** (`RONIN_SECURITY_PROFILE = dev | production`, default
`dev`) and a **fail-closed startup check** (`src/security/profile.ts`, evaluated in `server.ts`):

- **production**: the server **refuses to boot** (`process.exit(1)`) unless — authentication is
  enabled (`RONIN_AUTH_ENABLED`), audit is enabled (`RONIN_AUDIT_ENABLED`), transport security is
  present (in-process TLS **or** `RONIN_TLS_TERMINATED_AT_PROXY=true`), and OAuth signing keys are
  **non-ephemeral** when the OAuth server is on (`RONIN_OAUTH_PRIVATE_KEY/PUBLIC_KEY` set — ephemeral
  keys rotate on restart and silently invalidate live tokens).
- **consent** (`RONIN_CONSENT_ENFORCEMENT`) is **advisory even in production** — consent/DS4P/42 CFR
  Part 2 segmentation is deployment-dependent, so it warns rather than blocks. **OPEN QUESTION:**
  whether specific deployment classes should promote this to a hard requirement.
- **dev**: all checks are warnings only; never blocks (existing tests/synthetic flows unaffected).

## Consequences

- (+) Turns "opt-in, default off" into "provably on in production" — a single, auditable gate.
- (+) No new dependency; reuses the existing `authEnabled()/auditEnabled()/consentEnabled()` helpers.
- (−) Operators must set `RONIN_SECURITY_PROFILE=production` + the required envs to run in prod; a
  misconfigured prod deploy fails fast (intended). Documented in the security runbook.
- This is a *server posture* gate only — full HIPAA compliance (BAAs, risk assessment, breach
  process, ATO/FedRAMP) remains out of scope and organizational.
