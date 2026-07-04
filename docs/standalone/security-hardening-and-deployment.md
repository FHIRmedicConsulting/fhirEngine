# RoninStandAlone — Security Hardening & Deployment Runbook

_Operator guide for running RoninStandAlone securely. Pairs with ADR-0030 (enforcement),
ADR-0031 (TLS), ADR-0032 (production profile), ADR-0033 (HTTP hardening), ADR-0034 (supply chain),
and `docs/research/2026-07-03-tls-and-cms-compliance-security-deep-dive.md` (the full gap analysis)._

> **Alpha status.** This covers the *server-software* security baseline shipped for Alpha. Full
> HIPAA compliance (BAAs, risk assessment, breach process, ATO/FedRAMP), UDAP/TEFCA, and multi-node
> distributed rate limiting are **out of scope for Alpha** and tracked as follow-ups.

## 1. Profiles: dev vs production

`RONIN_SECURITY_PROFILE = dev` (default) | `production`.

- **dev** — controls are opt-in and off; the server only *warns* about gaps. For **synthetic data
  only** (Synthea). Never point dev at PHI.
- **production** — the server **refuses to boot** unless the required controls are on (fail-closed,
  ADR-0032). Set this for any deployment that could touch PHI.

## 2. Minimum secure production configuration

Run under 1Password (`op run --env-file=…`) so secrets are never written to disk. Required for a
`production` boot:

```bash
RONIN_SECURITY_PROFILE=production   # fail-closed gate
RONIN_AUTH_ENABLED=true             # SMART/JWT auth gate (ADR-0030 #1)
RONIN_AUTH_STRATEGY=jwks            # or 'local' (verify our own OAuth server) / 'oidc'
RONIN_AUDIT_ENABLED=true            # AuditEvent capture + accounting (ADR-0030 #2)

# Transport security — pick ONE:
#  (a) in-process TLS (single-node / dev-like):
RONIN_TLS_CERT=/path/fullchain.pem
RONIN_TLS_KEY=/path/privkey.pem
#  (b) TLS terminated upstream at a proxy/LB (recommended production default):
RONIN_TLS_TERMINATED_AT_PROXY=true

# If the SMART authorization server is enabled, keys MUST be static (not ephemeral):
RONIN_OAUTH_ENABLED=true
RONIN_OAUTH_PRIVATE_KEY=...   # PEM (via op run)
RONIN_OAUTH_PUBLIC_KEY=...

# Strongly recommended when serving consent/DS4P/42 CFR Part 2 data (advisory, not gated):
RONIN_CONSENT_ENFORCEMENT=true
```

If any required control is missing, boot aborts with a `security` log line naming the unmet control.

## 3. Transport security (ADR-0031)

- **Production default: terminate TLS at a reverse proxy / load balancer** and set
  `RONIN_TLS_TERMINATED_AT_PROXY=true`. The proxy owns cert lifecycle (ACME/short-lived) and can
  provide FIPS-validated crypto.
- **In-process HTTPS** (`RONIN_TLS_CERT/KEY`) is hardened automatically: TLS 1.2 min / 1.3 max,
  server-honored AEAD-only ECDHE ciphers (SP 800-52r2), obsolete protocols disabled. Override the
  cipher list with `RONIN_TLS_CIPHERS` only if you know why.
- **FIPS 140-3** is a *platform* property: run on a FIPS-validated OpenSSL/OS module. The server pins
  the policy but does not itself certify FIPS.
- **dev certs:** self-signed / mkcert with `subjectAltName` = your hostname.

## 4. HTTP-tier hardening (ADR-0033) — automatic

Applied to every response. Defaults are safe; tune via env:

| Concern | Default | Env |
|---|---|---|
| Security headers (HSTS, nosniff, frame-deny, CSP `default-src 'none'`, no-store) | always on | — |
| CORS | dev: permissive · prod: allowlist-only (none ⇒ same-origin) | `RONIN_CORS_ORIGINS` (comma list) |
| Body size limit | 10 MiB → 413 | `RONIN_MAX_BODY_BYTES` |
| Rate limiting | prod: on (600/client/min) · dev: off | `RONIN_RATE_LIMIT_ENABLED`, `RONIN_RATE_LIMIT_RPM` |

> Rate limiting is **per-process** (single-node). Behind multiple instances, also limit at the
> ingress/LB; a shared-store limiter is a post-Alpha follow-up.

## 5. Data & logging hygiene (non-negotiable)

- **Synthetic data only** outside production; de-identify before any non-prod use.
- **No PHI in logs / errors / SBOM / commits.** Unhandled errors return a generic OperationOutcome;
  server-side detail goes to the operator log — route that to a PHI-safe sink.
- Responses carry `Cache-Control: no-store`.

## 6. Supply chain (ADR-0034)

CI runs on every push/PR: the **`security`** job — `npm audit` (fails on high/critical), a CycloneDX
**SBOM** artifact, and `pip-audit` on the sidecar; and the **`scan`** job — **gitleaks** (secret
scanning, full history) and **Trivy** (dependency CVEs + Dockerfile/IaC misconfig + secrets,
HIGH/CRITICAL). Locally: `npm run audit`.

## 7. Pre-Alpha security checklist

- [ ] `RONIN_SECURITY_PROFILE=production` and the server boots (fail-closed gate passes).
- [ ] TLS terminated (proxy or in-process); HTTP redirected to HTTPS at the edge.
- [ ] Auth on, tested against a real IdP/JWKS (or our OAuth server with static keys).
- [ ] Audit on; AuditEvents landing; accounting-of-disclosures query verified.
- [ ] CORS allowlist set to the real client origins; rate limits sized for expected load.
- [ ] `npm audit` / `pip-audit` clean; SBOM archived for the release.
- [ ] Secrets only via `op run`; none in env files committed to git.
- [ ] Consent enforcement decision made (on, or explicitly N/A for this deployment).

## 8. Known follow-ups (post-Alpha)

**Done since Alpha baseline:** TLS **cert hot-reload** on renewal (`watchTlsCert`), **store-pluggable**
rate limiter (`RateLimitStore`, ready for a shared store), **gitleaks + Trivy** CI scanning.

**Remaining:** UDAP/TEFCA (SSRAA); a **shared-store rate limiter** (Redis — needs its own
disclosure/ADR); in-process **ACME** issuance; container **image** scanning (Trivy `image`);
OSS-Delta **tamper-evidence & audit-retention integrity**; and the **Da Vinci IGs** for the CMS-0057
B2B APIs. See the deep-dive doc's roadmap.
