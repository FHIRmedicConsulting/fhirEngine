# ADR-0020: CI/CD & Conformance Test Orchestration — GitHub Actions, Inferno + UDAP Test Gating Split, Three-Layer TS/Python Lockstep, Three-Channel Flighting, Hybrid Workspace Topology

- Status: **Accepted**
- Date: 2026-06-20
- Decider(s): Chad
- Session: 019
- Related: [ADR-0006](0006-smart-on-fhir-and-udap-security.md) §8 + §9, [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md), [ADR-0011](0011-write-contract.md), [ADR-0013](0013-deployment-posture.md), [ADR-0014](0014-conformance-targets-and-ig-matrix.md) §3 + §6 + §7, [ADR-0015](0015-validation-architecture.md) §3 + §7 (Amendment 2), [ADR-0017](0017-terminology-service.md) §6, [ADR-0019](0019-storage-and-pipeline-operations.md) §7 + §8

## Context

ADR-0019 closed the storage and pipeline mechanics of the operability slate. ADR-0020 closes the release-engineering subset: how Ronin gets from source to a deployable bundle, how the conformance gates are wired, how the two write-path implementations (TS + Python per ADR-0011) stay in lockstep, and how customers consume new versions.

Several upstream ADRs deferred concrete mechanics to this one:

- ADR-0014 §6 — CI/CD pipeline mechanics, IG upgrade choreography, Inferno integration topology.
- ADR-0006 §8 + §9 — IdP integration test matrix details, UDAP Test Tool CI orchestration, trust bundle refresh choreography.
- ADR-0011 — TS/Python write-path lockstep mechanism.
- ADR-0015 §7 — validation transpiler version coordination.
- ADR-0019 §7 + §8 + open Q — DLT pipeline + validator JAR upgrade choreography.

The architectural commitments stay narrow — release engineering shouldn't dictate runtime behavior beyond what the prior ADRs locked. ADR-0020 picks the build system, the test-kit gating policy, and the release-channel model; per-test orchestration scripts and customer-facing CI metrics dashboards stay implementation territory.

## Decision

### 1. CI/CD platform — GitHub Actions

Ronin's source + build pipeline run on **GitHub Actions**. Rationale: most common payer-engineering tooling; rich marketplace of pre-built actions; Databricks ships an official GitHub Action for bundle deploy that integrates cleanly with the DAB pattern from ADR-0013.

`.github/workflows/` ships in the repository with:

- `pr.yml` — runs on every PR: unit tests (both implementations), integration suite, fixture-divergence check, conformance-quick (a subset of Inferno tests that run in <10 min), lint, build dry-run.
- `main.yml` — runs on merges to `main`: full conformance gate (all test kits per §2), bundle artifact build + sign, candidate-channel publish.
- `release.yml` — runs on tag push: full conformance gate, RC promotion to stable, Marketplace listing publish, conformance evidence bundle publish per §11.
- `nightly.yml` — runs on schedule: full conformance gate against `main`, nightly artifact publish.
- `ig-upgrade.yml` — runs on schedule (per §3): monitors `packages.fhir.org` for new IG versions; opens PR with new pin; runs conformance gate; merges on green.
- `trust-bundle-refresh.yml` — runs on schedule (per §5): pulls DirectTrust UDAP community bundle; opens PR with refreshed bundle.

Reusable actions live under `.github/actions/` — `setup-databricks-cli`, `run-inferno`, `run-udap-test-tool`, `publish-conformance-evidence` are first-class composable units.

### 2. Conformance test gating split — hard-fail, soft-warn, manual

| Test kit | Tier | Rationale |
|---|---|---|
| Inferno SMART App Launch (STU2.2 — payer_baseline) | **Hard-fail** | CMS-0057 compliance gate |
| Inferno Da Vinci PDex | **Hard-fail** | CMS-0057 Patient Access + Payer-to-Payer |
| Inferno Bulk Data Test Kit | **Hard-fail** | CMS-0057 mandatory operation set |
| UDAP Test Tool | **Hard-fail** | TEFCA + HTI-2 substrate per ADR-0006 §1 |
| Inferno CARIN BB | **Soft-warn** | Less mature; flaky-test risk; override requires engineering sign-off |
| Inferno Da Vinci HRex | **Soft-warn** | Same; CMS-foundational but tooling immature |
| Touchstone | **Manual** (release-time playbook) | Broader; less prescriptive for CMS-specific tests |
| DirectTrust UDAP Certification | **Manual** (procurement gate; customer-funded) | Not gating GA; required for some customer procurement processes |
| Inferno SMART App Launch STU1 + STU2.0 + STU2.1 | **Hard-fail** | Catalog members per ADR-0014 §2 ratchet model |
| Inferno Da Vinci CDEx + PAS + CRD + DTR | **Soft-warn** initially, **hard-fail** by 01/01/2027 | CMS-0057-F deadline |
| Inferno Patient Access | **Hard-fail** | CMS-9115-F (already past) |

Override path for soft-warn: a `conformance-soft-warn-override` label on the PR + reviewer sign-off in the conformance evidence record. Each override carries an expiration (default 30 days) tracked in the conformance evidence bundle (§11).

Hard-fail blocks merge; soft-warn blocks-warn but allows the labeled override; manual lives in the release playbook (per ADR-0021 follow-ups for runbook structure).

### 3. IG upgrade choreography

```
1. `ig-upgrade.yml` workflow runs weekly (Sunday 00:00 UTC).
2. Workflow pulls package manifests from packages.fhir.org for each tracked IG canonical URL.
3. For each IG with a new version not in the active catalog:
   a. Workflow opens a PR titled `IG upgrade: <ig_canonical> <new_version>`.
   b. PR adds the new version to the `ronin_ig_catalog.yml` (per ADR-0014 §2 Layer 1).
   c. PR updates the validation transpiler artifacts via the §6 mechanism.
   d. PR re-runs the conformance gate against the new version.
4. On green: PR merges; bundle artifact rebuilds; new version flows to the `rc` channel per §9.
5. After RC bake period (default 30 days; configurable per IG):
   a. Version promotes to `stable`.
   b. Customers see the new version as a candidate in their `ronin_ig_versions` ratchet (per ADR-0014 §3).
   c. Release notes generated from the IG changelog + Ronin-specific notes.
6. Customer activates per ADR-0014 §3 operator-pull pattern.
```

Failure modes:

- New IG version fails the conformance gate → PR stays open; Slack notification to engineering; manual triage. The active catalog is unchanged; customers see no new version.
- New IG version introduces a breaking change → PR adds the new version as a *new tier table* per ADR-0019 §1 (schema evolution); old version remains the active default for `ronin_ig_versions`; new version requires explicit operator activation.

Deprecation: when an IG version drops out of CMS-required floor (per ADR-0014 §1), CI flags it; deprecation notice goes to customers 90 days before catalog removal.

### 4. IdP integration test matrix — mechanics

| IdP | CI shape | Sandbox / endpoint |
|---|---|---|
| **Okta** | Per-PR conformance-quick test against Okta dev tenant | `ronin-ci.okta.com` (dev tenant; per-PR scope ephemeral apps) |
| **Microsoft Entra** | Per-PR conformance-quick test against Entra dev tenant | `ronin-ci.onmicrosoft.com` |
| **Login.gov sandbox** | Per-PR conformance-quick test | Login.gov public sandbox (federal IAL2 test path) |
| **Custom OIDC** | Per-PR conformance-quick test against in-CI `oidc-test-server` | Self-hosted via GitHub Actions container; resets per-PR |
| **id.me** | Manual playbook (customer-funded license) | Production; restricted to release-time spot checks |
| **Ping Identity** | Manual playbook | On-demand; depends on customer license access |
| **ForgeRock** | Manual playbook | On-demand; depends on customer license access |
| **AWS Cognito** | Manual playbook | Smaller market share; not in v1 CI |

Per-PR runs cover SMART App Launch (user-facing + Backend Services) + UDAP DCR + JWT-bearer flows. Manual playbook runs gate any release that touches the IdP integration layer.

Sandbox flake handling: in-CI IdP tests retry up to 3 times on transient failures (rate limit, network); persistent failure escalates to soft-warn (engineering can override with sign-off). Login.gov sandbox has documented rate limits; CI tests pace requests to stay under.

### 5. Trust bundle refresh choreography

```
1. `trust-bundle-refresh.yml` workflow runs weekly (Wednesday 00:00 UTC).
2. Workflow pulls DirectTrust UDAP community bundle from the published distribution URL.
3. Workflow computes diff vs. current bundle (added/removed/expired certs).
4. If non-empty:
   a. Workflow opens PR titled `Trust bundle refresh: <YYYY-MM-DD>`.
   b. PR replaces `scripts/trust-bundles/udap-community.pem`.
   c. PR runs UDAP Test Tool against the new bundle.
5. On green: PR merges; bundle artifact rebuilds; flows to `rc` per §9.
6. Customer activates per ADR-0006 §9 operator-pull pattern via `ronin udap activate-trust-bundle <version>`.
```

Per-deployment additions (`ronin_udap_additional_cas` per ADR-0006 §9) layer on top of the activated community bundle; CI doesn't manage them.

### 6. Validation transpiler version coordination

The transpiler (per ADR-0015 §3) ships per-FHIR-version + per-IG-version artifacts pinned in the `validation_artifacts` Delta table.

```
1. CI builds transpiler artifacts on every release (per §1 main.yml).
2. Artifacts published to UC volume at `ronin.engineering.validation_artifacts/<fhir_version>/<ig_pin_hash>/`.
3. CI writes a row to `ronin.engineering.validation_artifacts_registry` with:
   (fhir_version, ig_pin_hash, transpiler_version, validator_jar_version, artifact_uri, built_at).
4. Customer deploy reads the active pin from `ronin_<warehouse>.gold.validation_artifacts`
   (per ADR-0015 §7); the pin references a row in the engineering registry.
5. On IG version activation (operator-pull per ADR-0014 §3), the customer's pin updates;
   DLT pipelines restart per §8 to load the new artifacts.
```

Validator JAR shipped alongside transpiler artifacts; same `(fhir_version, ig_pin_hash)` key. Per ADR-0019 §8, the JAR is invoked as a Spark library; library load happens on DLT pipeline restart.

### 7. TS / Python write-path lockstep — three-layer mechanism

ADR-0011's two-implementation gap is closed by three coordinated layers.

#### 7.1 Shared test fixture corpus

Location: `tests/shared-fixtures/`. Contents:

- FHIR Bundle JSON files covering: single-resource POSTs (every supported resource type), Bundle transaction with cross-resource References, conditional-create (idempotency), conditional-update (version-conflict + happy path), Bundle batch (best-effort semantics), MPI-bound writes (PII normalization + Splink integration), Consent writes (Provenance attached), AuditEvent writes (per ADR-0016).
- Per-fixture metadata (`<fixture>.expected.json`): the canonical Bundle output after Ronin's write pipeline (fhir_id minted, References rewired, audit events emitted, MPI links resolved).
- Per-fixture variant tags (`@idempotency`, `@reference-resolution`, `@mpi`, `@audit`, `@consent`, `@error-path`) drive subset-test runs.

The corpus is the canonical source of truth for "what the write semantics produce." Adding to the corpus requires adding the fixture in both `tests/shared-fixtures/inputs/` and the expected output.

#### 7.2 Cross-implementation integration suite

- Python: pytest harness loads each fixture, runs through `ronin_write_py.process_bundle()`, deep-diffs against the expected output. Result captured in `ci-results/python.json`.
- TypeScript: Vitest harness loads each fixture, runs through `roninWriteTs.processBundle()`, deep-diffs against the expected output. Result captured in `ci-results/typescript.json`.
- Divergence detector: a post-step compares the two ci-results JSON files; any field where the implementations diverge from each other (independent of either matching the expected output) is a hard CI fail.

#### 7.3 Code-review discipline + lint enforcement

- A CI check inspects PR diffs: if files under `packages/write-ts/src/semantics/**` change without parallel changes under `packages/write-py/src/semantics/**` (or vice versa), the PR blocks merge unless labeled `single-side-write-change` AND signed off by a designated reviewer (defined in `.github/CODEOWNERS`).
- Lint rules in both languages enforce a shared FHIR-write-semantics style guide: identifier system canonicalization patterns, reference-resolution invariants, idempotency-key generation, audit-event capture points. Violations are CI errors.

#### 7.4 Divergence telemetry

A `ronin-write-divergence-report.md` artifact is published per release listing any divergences caught + their resolution (fixed vs. accepted-with-rationale). Trends visible across releases.

### 8. DLT pipeline + Validator JAR upgrade choreography

Both follow the operator-pull pattern from ADR-0014 + ADR-0017 + ADR-0019 §9.

**DLT pipeline code change:**
1. CI builds DLT pipeline notebook + library bundle (per ADR-0019 §7 DLT-in-bundle pattern).
2. DAB deploy publishes the new artifact to UC volume at `ronin.engineering.dlt_artifacts/<version>/`.
3. Customer deploy lays down the new artifact but does NOT update the active pipeline.
4. Operator activates via `ronin dlt activate <pipeline_name> <version>`:
   - Pipeline stops (serverless mode; ~30s).
   - New artifact loaded.
   - Pipeline restarts.
   - Prior artifact retained for rollback (`ronin dlt activate <pipeline_name> <prior_version>`).
5. Active pipeline state captured in `ronin_<warehouse>.gold.dlt_artifacts_registry` for audit.

**Validator JAR upgrade:** same flow, gated on the active `validation_artifacts` pin (per §6). New JAR loaded on DLT pipeline restart; prior JAR retained in UC volume for rollback.

**Custom validator JAR distribution:** customers needing JARs built with additional federal-specific IG packages upload to their deployment's UC volume at `ronin_<warehouse>.custom.validator_jars/`; `ronin_validator_jar_path` override (per ADR-0019 §8) points the DLT pipeline at the custom JAR on activation.

### 9. Pre-release flighting — three channels

| Channel | Audience | Distribution | Cadence |
|---|---|---|---|
| **stable** | All customers (default) | Marketplace listing v1 (primary) | Monthly releases + hotfix as needed |
| **rc** | Customers opting in via `ronin_release_channel = rc` | Marketplace listing v1-rc (separate listing) | Every merge to `main` |
| **nightly** | Engineering only; not Marketplace-listed | `ronin.engineering.nightly_artifacts/<date>/` UC volume | Daily build from `main` |

Bake period: code merges to `main` → published to `rc` → 30-day default bake → promotes to `stable`. Per-IG-version bake overrides allowed (e.g., a critical SMART App Launch fix may promote in 7 days; a major US Core jump may bake for 90 days).

Customers on `rc` get the conformance evidence bundle (§11) updated per merge; engineering can use the `rc` channel's failure data to gate `stable` promotion.

### 10. CI workspace topology — hybrid (shared + ephemeral)

| Test stage | Workspace | Rationale |
|---|---|---|
| Unit tests + integration suite + lint | GitHub Actions runners (no Databricks workspace) | Pure in-language; no Databricks dependency; fastest |
| Smoke tests against Databricks (DAB deploy validation, simple SQL) | **Shared** Ronin engineering Databricks workspace; ephemeral catalogs prefixed `ci_pr<PR_number>_` | Cheap; deployment-bootstrap POC pattern (per ADR-0013); parallel-PR isolation via prefix |
| Full Inferno + UDAP Test Tool conformance runs | **Per-PR ephemeral Databricks workspaces** spun up via Workspace API; torn down on completion | Real isolation; conformance tests run long (~30 min); failure modes can leak state otherwise |
| Nightly + RC full-suite runs | **Dedicated** Ronin engineering workspace (always-on; not ephemeral) | Predictable; observable; long-running test reports preserved |

Hybrid keeps the cost envelope low (most PRs use the shared workspace's prefix-isolation pattern) while reserving full ephemeral isolation for the test runs that need it. Per ADR-0009 + ADR-0013, Databricks Free Edition hosts a substantial portion of the surface; ephemeral conformance runs use a paid workspace.

### 11. Conformance test result publication

Every release publishes a **conformance evidence bundle** alongside the Marketplace listing:

```
conformance-evidence-<version>.tar.gz
├── inferno/
│   ├── smart-app-launch-stu2.2.html
│   ├── smart-app-launch-stu2.0.html
│   ├── pdex.html
│   ├── bulk-data.html
│   ├── carin-bb.html       (soft-warn results included)
│   └── hrex.html
├── udap/
│   └── udap-test-tool-report.html
├── summary.md              (customer-readable; counts + key passes/fails per kit)
├── overrides.json          (soft-warn override records + expirations)
├── ig-pin-manifest.json    (active IG versions tested against)
└── metadata.json           (release version, commit SHA, build date)
```

Per-version evidence bundles preserved indefinitely at `https://marketplace.<host>/ronin/conformance/<version>/` (URL pattern; concrete host belongs in ADR-0021 install runbooks).

Customer compliance teams reference the per-version bundle in their CMS-0057 audit submissions. The `summary.md` is plain-language for non-technical readers; raw HTML reports are for auditor review.

Per ADR-0014 §6, the deployment profile flag drives which evidence subset is mandatory: `payer_baseline` requires the full bundle; `provider_baseline` excludes the payer-specific IGs (CARIN BB, PDex, PDex Plan Net, PDex Formulary, PAS).

## Consequences

**What this commits Ronin to:**

- GitHub Actions as the build substrate — locked.
- Inferno + UDAP Test Tool as gating conformance kits — locked.
- Two-implementation lockstep mechanism is operationally heavy; the three-layer §7 design is the price of running TS + Python for the same FHIR semantics.
- Conformance evidence bundles are a permanent compliance artifact — every release ships one; URL pattern persists; old bundles never deleted.
- Three-channel release model means every change progresses through `rc` before reaching customers — adds 30 days to the typical-change cadence.

**What it enables downstream:**

- ADR-0021 can reference §11 as the source for customer-facing compliance documentation.
- IG upgrade choreography is closed; ADR-0014 §6 follow-up retired.
- TS / Python implementation parity is observable across releases via the divergence telemetry.
- The DLT + Validator JAR upgrade flow lets customers stay on a stable production version while testing new artifacts in their own deployment per ADR-0014 §3.

**What it costs:**

- GitHub Actions minutes for the per-PR conformance-quick suite (~5-10 min × per-PR run × ~20 PRs/day at engineering steady state) + the per-release full suite (~45 min × per-release). Budget within Ronin engineering footprint.
- The dedicated engineering Databricks workspace + per-PR ephemeral workspaces add ~$2-5K/month at typical engineering velocity. Mitigated by the shared-workspace + Free Edition leverage from ADR-0013.
- Soft-warn overrides need engineering discipline; the expiration tracker (§2 + §11 overrides.json) prevents permanent overrides but requires periodic review.
- The TS/Python lockstep mechanism is a permanent engineering tax. Mitigated by reducing the surface area of shared FHIR-write semantics (most code is implementation-specific; only the write path is duplicated).

## Alternatives considered

- **Databricks Workflows as CI** — rejected per §1. Couples Ronin's release engineering to a customer-facing product surface; harder to evolve independently; less ecosystem.
- **GitLab CI** — rejected as the v1 default; equivalent capability to GitHub Actions but smaller payer-engineering footprint. Documented as supported via a `.gitlab-ci.yml` template in the Operability ADR follow-ups if a customer-engineering team wants it.
- **All-hard-fail conformance gating** (no soft-warn tier) — rejected per §2; CARIN BB + HRex test kit immaturity would create gratuitous releases blockers.
- **One write-path implementation in v1; deferred TS or Python to v1.x** — rejected by ADR-0011. The TS/Python lockstep mechanism is the cost of that decision; ADR-0020 §7 just makes it operationally tractable.
- **Always-ephemeral workspaces** for all CI — rejected per §10. Cost would be 3-5x higher with marginal benefit for the unit + integration tier.
- **Two-channel release** (stable + nightly only; no `rc`) — rejected per §9. RC channel is where the conformance gate's full results live before customers see them; without it, regression risk shifts to customers.
- **No divergence telemetry** (rely only on lockstep code review) — rejected per §7.4. Code review catches most things but the integration-suite + telemetry add a second layer that's automated.
- **Pre-built Inferno Docker image vs. running Inferno on demand** — operational detail; both work. CI uses pre-built images for performance; runners pull on warm cache.

## Follow-up ADRs queued

- **ADR-0020 Amendment: GitLab CI template** — when a customer-engineering team needs to fork to GitLab; reusable workflow translation guide.
- **Marketplace listing publication ADR** (queued from ADR-0013 follow-ups) — uses §9 + §11 as the artifact pipeline; concrete listing format + per-cloud submission steps.
- **Validator throughput POC results** (per ADR-0015 §8 + ADR-0019 §6) — informs the conformance-quick subset selection in §1 `pr.yml`.
- **TS/Python performance parity metrics** — when the two implementations' throughput diverges, surface as part of the per-release telemetry.

## Open questions not closed by this ADR

- **Inferno test kit version cadence vs. Ronin release cadence** — Inferno updates roll independently; Ronin's CI tracks but doesn't gate Ronin releases on Inferno version updates. Concrete coordination details fold into the Operability ADR follow-up.
- **Conformance evidence bundle delivery mechanism** — per-version URL pattern committed in §11; the concrete CDN / S3-public-bucket choice lives in ADR-0021 install runbooks.
- **Engineering hotfix process** — when a critical security fix needs to bypass the 30-day RC bake, what's the override path? Documented in the engineering runbook (ADR-0021); ADR-0020 establishes the channel structure.
- **Custom IdP integration test playbooks** — id.me, Ping, ForgeRock, Cognito playbooks live in `docs/operability/idp-playbooks/`; concrete content lives in the Operability research notes.
- **Soft-warn override governance** — who can label `conformance-soft-warn-override`? CODEOWNERS-gated, but the policy for "when is override appropriate" needs an engineering RFC. Not blocking ADR-0020 acceptance.

## Sources

- [GitHub Actions documentation](https://docs.github.com/en/actions) — workflow primitives
- [Databricks GitHub Action](https://github.com/databricks/setup-cli) — DAB deploy integration
- [Inferno Framework — SMART App Launch Test Kit](https://inferno.healthit.gov/test-kits/smart-app-launch/) — primary conformance gate
- [Inferno Framework — Da Vinci PDex Test Kit](https://github.com/inferno-framework/davinci-pdex-test-kit)
- [Inferno Framework — Bulk Data Test Kit](https://github.com/inferno-framework/bulk-data-test-kit)
- [UDAP.org Test Tool](https://www.udap.org/UDAPTestTool/)
- [DirectTrust UDAP Accreditation](https://accreditation.directtrust.org/programs/udap)
- [Login.gov Developer Sandbox](https://developers.login.gov/) — sandbox endpoints for §4
- [Touchstone Conformance Tests](https://touchstone.aegis.net/touchstone/) — broader test framework (manual tier)
- ADR-0006 §8 + §9 — IdP test matrix + trust bundle refresh
- ADR-0011 — write contract that §7 keeps in lockstep
- ADR-0013 — DAB deploy pattern that §1 invokes
- ADR-0014 §3 + §6 + §7 — IG ratchet + CI/CD + Inferno gates
- ADR-0015 §3 + §7 — validation transpiler + artifact pin pattern that §6 + §8 implement
- ADR-0017 §6 — operator-pull activation pattern that §8 mirrors
- ADR-0019 §7 + §8 — DLT-in-bundle + Spark-library validator that §8 orchestrates
