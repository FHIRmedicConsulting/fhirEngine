# ADR-0034: Supply-Chain Security — SBOM & Dependency Scanning

- Status: **Accepted** 2026-07-04 (Chad — "mark the ADRs approved")
- Date: 2026-07-04
- Decider(s): Chad
- Session: standalone security hardening
- Related: [component-disclosure-review](../governance/component-disclosure-review.md), [[component-disclosure-policy]], `docs/research/2026-07-03-tls-and-cms-compliance-security-deep-dive.md`

## Context

The component-disclosure policy + NIST SP 800-53 SA/SR families expect a Software Bill of Materials
and continuous dependency-vulnerability scanning. CI had neither. The open-core Apache-2.0 posture
makes SBOM/SCA table stakes for downstream adopters and for any future ATO.

## Decision

Add a **`security` CI job** (`.github/workflows/ci.yml`) — **no new runtime dependency**:

- **`npm audit --omit=dev --audit-level=high`** — fails the build on high/critical advisories in the
  server's production tree (`npm run audit`).
- **CycloneDX SBOM** via npm's built-in `npm sbom --sbom-format cyclonedx --omit dev`, uploaded as a
  build artifact. (The linked `file:` workspace `@ronin/fhir-types` needs its deps installed first —
  the job runs `npm ci` there so the SBOM tree is complete.)
- **`pip-audit`** against the Python sidecar's `requirements.txt`.

## Consequences

- (+) Vulnerability gate + machine-readable SBOM on every push/PR; covers both the TS server and the
  Python sidecar. (+) Uses only npm/pip built-ins + `pip-audit` (CI-only tool, disclosed here).
- (−) `npm audit` advisory churn can cause transient CI failures — mitigated by `--audit-level=high`
  (only high/critical block). **OPEN QUESTION:** whether to add secret-scanning (e.g. gitleaks) and
  container image scanning (Trivy) — recommended follow-ups, not in this ADR.
- License/attribution generation from the SBOM for the open-core distribution is a follow-up.
