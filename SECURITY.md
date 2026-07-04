# Security Policy

RoninStandAlone is a FHIR R4 server intended to handle **Protected Health Information (PHI)** in
production. We take security seriously and appreciate responsible disclosure.

> ⚠️ **Maintainers:** replace the `SECURITY_CONTACT` placeholder below with a monitored security
> address and enable **GitHub Private Vulnerability Reporting** (Settings → Code security) before the
> first public release.

## Reporting a vulnerability

**Please do NOT open a public issue for security vulnerabilities.**

Report privately via either:

1. **GitHub Private Vulnerability Reporting** — the repository's **Security → Report a vulnerability**
   tab (preferred), or
2. **Email** — `SECURITY_CONTACT` (e.g. `security@<project-domain>`), encrypted if possible.

Please include:
- a description of the issue and its impact,
- steps to reproduce (a minimal PoC if possible),
- affected version/commit and configuration (e.g. security profile, auth strategy),
- any suggested remediation.

**Never include real PHI** in a report. Use synthetic data (Synthea) to demonstrate an issue.

## What to expect

- **Acknowledgement** within **3 business days**.
- An initial assessment (severity + whether we can reproduce) within **10 business days**.
- We will keep you updated on remediation progress and coordinate a disclosure timeline with you
  (target: fix or mitigation within **90 days**, sooner for actively-exploited issues).
- With your permission, we will credit you in the release notes / advisory.

## Scope

In scope: the FHIR server (`packages/ronin-server-ts`), the delta-rs sidecar
(`packages/ronin-server-ts/sidecar`), the deploy artifacts (`deploy/`), and the security controls
(auth/audit/consent/TLS/hardening/UDAP — ADR-0030..0036).

Out of scope: issues requiring a compromised host/operator, third-party dependencies (report those
upstream; we track them via `npm audit` / `pip-audit` / Trivy in CI), and deployments that ignore the
documented production security profile (running the `dev` profile against real PHI is a
misconfiguration, not a server vulnerability).

## Supported versions

RoninStandAlone is **pre-alpha** (`0.x`). Security fixes land on the latest `main`; there is no LTS
branch yet. Pin to a commit and watch releases.

## Deploying securely

Running securely is a shared responsibility. Use the **production security profile** (fail-closed)
and follow the pre-alpha checklist in
[`docs/standalone/security-hardening-and-deployment.md`](docs/standalone/security-hardening-and-deployment.md):
TLS, authentication, audit, consent, CORS/rate limits, secrets via a manager (never in git), and
encryption at rest.
