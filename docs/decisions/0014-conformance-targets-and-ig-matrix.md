# ADR-0014: Conformance Targets and IG Matrix — Floor + CI/CD Upgrade Rails

- Status: **Accepted**
- Date: 2026-06-19
- Decider(s): Chad
- Session: 018
- Related: [ADR-0008](0008-updated-vision-and-scope.md), [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md), [ADR-0010](0010-storage-shape.md), [ADR-0011](0011-write-contract.md), [ADR-0012](0012-master-patient-index.md), [ADR-0013](0013-deployment-posture.md), [docs/research/2026-06-19-fhir-server-foundations.md](../research/2026-06-19-fhir-server-foundations.md), [docs/research/2026-06-19-cms-2027-compliance-landscape.md](../research/2026-06-19-cms-2027-compliance-landscape.md), [docs/research/2026-06-19-validation-architecture.md](../research/2026-06-19-validation-architecture.md)

## Context

ADR-0008 sets Ronin's v1 customer profile as the 10M-member CMS-0057-impacted US payer. CMS-0057-F production-API compliance dates land 01/01/2027 (MA + Medicaid/CHIP FFS + Medicaid managed care + CHIP managed care + QHPs on FFEs). The cumulative CMS-required APIs by that date are: Patient Access (with new prior auth info), Provider Access, Payer-to-Payer, Prior Authorization, Provider Directory, Drug Formulary, `$member-match`, Bulk Data. Each is profiled by a stack of HL7/Da Vinci/CARIN implementation guides — 13 IGs loaded simultaneously for a fully-conformant payer deployment per the CMS-2027 compliance landscape note §3.

Three structural realities frame the conformance posture:

1. **IGs evolve annually.** US Core just jumped 6.1 → 7 → 8 → 9 across 2024–2026; CARIN BB rebased to US Core 7 at edition 2.2.0 (March 2026); PAS released 2.1.0 production with 2.2.1 in ballot; HRex moved 1.0 → 1.1. The IG matrix is not stable on a 2-3 year horizon.
2. **CMS adopts specific versions.** The regulatory floor is the CMS-adopted version per IG (US Core 6.1.0, CARIN BB 2.0.0, PAS 2.0.1, HRex 1.0.0, PDex 2.0.0, PDex Plan Net 1.1.0). Newer versions are voluntary unless ONC adopts them through a subsequent NPRM.
3. **The IGs interlock.** A Coverage resource may claim conformance to US Core + CARIN BB + PDex + HRex simultaneously; each profiles the others or depends on shared base infrastructure. Version coordination matters; mixing US Core 6.1 with CARIN BB 2.2 (which rebased to US Core 7) breaks.

Session-018 clusters A (licensed code systems) and B (version pinning + CI/CD upgrade rails) locked the v1 posture: floor at the CMS-adopted minimum per IG; bundle ships every adopted version; CI/CD upgrade rails operational by 01/01/2027 carry customers up the version curve at their own pace. This ADR ratifies that posture.

## Decision

### 1. v1 IG floor — CMS-adopted regulatory minimum per IG

Ronin v1 defaults to the regulatory floor per IG. The default is the most conservative production-ready posture; customers can pin upward per deployment.

| IG | v1 floor (default) | Latest published (2026-06-19) | CMS adoption status |
|---|---|---|---|
| US Core | **6.1.0** | 9.0.0 | CMS adopted 6.1.0 in CMS-0057 NPRM |
| CARIN BB | **2.0.0** | 2.2.0 | CMS adopted 2.0.0; 2.x is voluntary |
| Da Vinci HRex | **1.0.0** | 1.1.0 | CMS adopted 1.0.0; foundational for Provider Access + P2P |
| Da Vinci PDex | **2.0.0** | 2.2.0 | CMS adopted 2.0.0 for Payer-to-Payer |
| Da Vinci PDex Plan Net | **1.1.0** | 1.1.0 | CMS adopted 1.1.0 for Provider Directory |
| Da Vinci PDex Formulary | **2.0.0** | 2.0.x | CMS adopted 2.0.0 for Drug Formulary (MA Part D) |
| Da Vinci PAS | **2.0.1** | 2.1.0 (production); 2.2.1 (ballot) | CMS adopted 2.0.1 for Prior Authorization |
| Da Vinci CRD | **2.0.x** | 2.x | CMS adopted; CDS Hooks for PA-required determination |
| Da Vinci DTR | **2.0.x** | 2.x | CMS adopted; questionnaire-driven PA data collection |
| Da Vinci CDEx | **2.0.0** | 2.1.0 | Provider-side; CMS-adopted floor for Provider Access |
| SMART App Launch | **2.0.0** | 2.2.0 | OAuth substrate; CMS-adopted floor |
| FHIR Bulk Data | **2.0.0** | 2.0.0 | `$export` + `$import`; CMS-adopted current |
| FHIR core terminology operations | **R4 (4.0.1)** | R5 / R6 | `$validate-code`, `$expand`, `$lookup`, `$translate`, `$subsumes`, `$closure` defined in FHIR core — not a separate IG (Amendment 1) |
| FHIR Terminology Ecosystem IG | **1.9.1** (continuous build, R5-based) | per HL7 release | Server requirements: TerminologyCapabilities, tx-resource, cache-id, error coding; requirements port back to R4 (Amendment 1; ratified in ADR-0017 §1) |
| HL7 Terminology (THO) — `hl7.terminology` | **7.2.0** | per HL7 release | Content: v2 tables, v3 vocabularies, FHIR vocabularies, stubs for licensed externals; pulled transitively via IG `package.json` dependencies; per ADR-0017 §7 (Amendment 1) |

Customers can pin upward via `ronin_ig_versions` deployment variable. The bundle ships every adopted version per IG (see §3) so the climb path is local.

### 2. The bundle as IG catalog + per-deployment IG selection

The bundle ships an **IG catalog** — every adopted version of every supported IG, available for any deployment to activate. **Three layers of configurability** map cleanly onto the catalog:

**Layer 1 — Catalog membership (Ronin engineering).** Which IGs Ronin officially supports across all customers. Ronin's CI/CD pipeline (§6) maintains the catalog. New IGs and new versions enter the catalog via the **standard FHIR Package mechanism** (next subsection); customer deployments inherit catalog updates on next `bundle deploy`.

**Layer 2 — Active selection (`ronin_active_igs`, per deployment).** Which IGs a customer's deployment activates from the catalog. Default activation derives from `ronin_deployment_profile` (§4); customers can extend, subset, or override per deployment.

**Layer 3 — Version pinning (`ronin_ig_versions`, per active IG).** For each activated IG, which version is in effect for this deployment. Default tracks the regulatory floor (§1); customers can pin upward per IG.

```yaml
ronin_deployment_profile: payer_baseline   # picks defaults for layers 2 + 3

# Layer 2 — per-deployment active selection (override)
ronin_active_igs:
  - hl7.fhir.us.core
  - hl7.fhir.us.carin-bb
  - hl7.fhir.us.davinci-hrex
  - hl7.fhir.us.davinci-pdex
  - hl7.fhir.us.davinci-pdex-plan-net
  - hl7.fhir.us.davinci-pdex-formulary
  - hl7.fhir.us.davinci-pas
  - hl7.fhir.us.davinci-crd
  - hl7.fhir.us.davinci-dtr
  - hl7.fhir.smart-app-launch
  - hl7.fhir.uv.bulkdata
  - hl7.fhir.uv.tx-ecosystem
  # add or omit per deployment needs

# Layer 3 — per-active-IG version pin
ronin_ig_versions:
  hl7.fhir.us.core: 6.1.0          # regulatory floor (default)
  hl7.fhir.us.carin-bb: 2.0.0
  # ... pin only the IGs that need a non-floor version
```

### 2.1 Catalog layout

```
ig_packages/
├── hl7.fhir.us.core-6.1.0.tgz
├── hl7.fhir.us.core-7.0.0.tgz
├── hl7.fhir.us.core-8.0.0.tgz
├── hl7.fhir.us.core-9.0.0.tgz
├── hl7.fhir.us.carin-bb-2.0.0.tgz
├── hl7.fhir.us.carin-bb-2.1.0.tgz
├── hl7.fhir.us.carin-bb-2.2.0.tgz
├── hl7.fhir.us.davinci-pas-2.0.1.tgz
├── hl7.fhir.us.davinci-pas-2.1.0.tgz
├── hl7.fhir.us.davinci-pas-2.2.1.tgz   (ballot, marked accordingly)
├── ... (one .tgz per adopted version of every IG in §1)
└── catalog.yml                          (manifest: canonical URL → versions available)
```

`catalog.yml` is the build-time manifest the deployment reads to validate `ronin_active_igs` + `ronin_ig_versions` selections. Bundle-build-time integrity check verifies each `.tgz`'s canonical URL + version + dependency declarations against the manifest.

Total disk: ~150-250 MB across all packages; trivial for the bundle.

### 2.2 Standard FHIR Package mechanism for adding new IGs

**Adding a new IG is npm-style for FHIR — no Ronin-specific package format.**

A FHIR IG is a [FHIR Package](https://confluence.hl7.org/display/FHIR/NPM+Package+Specification) — a `.tgz` archive with a `package.json` declaring:

- `name`: canonical URL (e.g., `hl7.fhir.us.davinci-pas`)
- `version`: SemVer (e.g., `2.1.0`)
- `fhirVersions`: which FHIR core versions this IG supports
- `dependencies`: other IG packages this depends on (e.g., `hl7.fhir.us.core: 6.1.0`)
- Package contents: StructureDefinitions, ValueSets, CodeSystems, ConceptMaps, examples, narratives

**Ronin-side workflow for catalog additions:**

1. CI/CD pipeline (§6) polls packages.fhir.org weekly for new versions and net-new IGs across tracked canonical URLs (plus a watchlist of upcoming IGs).
2. New `.tgz` archives download into `ig_packages/`; `catalog.yml` regenerates.
3. Validation transpiler (per ADR-0015 §3) **and** terminology auto-provisioner (per ADR-0015 §10 / ADR-0017) automatically discover new packages on next deployment; the transpiler emits SQL artifacts; the provisioner loads inline ValueSets/CodeSystems + fetches external terminology as needed (VSAC if NLM key present; direct sources otherwise).
4. CapabilityStatement generator (§10) reflects them when activated.
5. Inferno test suite (§7) expands when corresponding Inferno test kits exist.
6. Customer adoption happens at customer-controlled pace via `ronin_active_igs` updates.

**Customer-side workflow for net-new IGs** (state Medicaid, custom payer profiles):

1. Customer obtains the FHIR Package `.tgz` (from packages.fhir.org, simplifier.net, or self-built via the IG Publisher).
2. Drops it into the deployment's `extra_ig_packages/` (or references a URL).
3. Adds the canonical URL to `ronin_extra_igs` deployment variable.
4. `bundle deploy` picks it up; transpiler emits SQL artifacts; terminology auto-provisioner loads in-package ValueSets and CodeSystems; CapabilityStatement reflects it.

No Ronin-specific format; no engineering involvement required for customer-side IG additions. The FHIR Package ecosystem is the integration surface.

### 3. Per-deployment IG version pinning (Layer 3 detail)

The `ronin_ig_versions` variable selects the active version per **active** IG (per §2 Layer 2 selection). Versions not pinned default to the regulatory floor from §1.

```yaml
# Defaults (when not overridden) — track the regulatory floor
hl7.fhir.us.core: 6.1.0
hl7.fhir.us.carin-bb: 2.0.0
hl7.fhir.us.davinci-hrex: 1.0.0
hl7.fhir.us.davinci-pdex: 2.0.0
hl7.fhir.us.davinci-pdex-plan-net: 1.1.0
hl7.fhir.us.davinci-pdex-formulary: 2.0.0
hl7.fhir.us.davinci-pas: 2.0.1
hl7.fhir.us.davinci-crd: 2.0.0
hl7.fhir.us.davinci-dtr: 2.0.0
hl7.fhir.us.davinci-cdex: 2.0.0
hl7.fhir.smart-app-launch: 2.0.0
hl7.fhir.uv.bulkdata: 2.0.0
hl7.fhir.uv.tx-ecosystem: 1.0.0
```

Customer override (per IG):

```yaml
ronin_ig_versions:
  hl7.fhir.us.core: 9.0.0          # newer than floor; selected per deployment
  hl7.fhir.us.carin-bb: 2.2.0      # also pinned newer (rebases to US Core 7+)
```

Bundle validation at deploy time catches:

- **Cross-IG version-incompatibility** (e.g., CARIN BB 2.2.0 + US Core 6.1.0 — fails because CARIN BB 2.2.0 requires US Core 7+). The validator emits a clear error directing the customer to pin US Core upward.
- **Inactive IG version pin** (e.g., pinning `hl7.fhir.us.davinci-cdex: 2.0.0` when CDEx isn't in `ronin_active_igs`). Warning only — pin is ignored.
- **Catalog miss** (e.g., pinning `hl7.fhir.us.core: 10.0.0` when 10.0.0 isn't in the catalog). Hard error — directs customer to update their bundle version.

### 4. Three default deployment profiles

The `ronin_deployment_profile` deployment variable selects from three shipped profiles. Each profile is a preset for `ronin_active_igs` (§2 Layer 2) + `ronin_ig_versions` (§3) + validation strictness + MPI profile + audit retention + licensed-system defaults. Customers can use a profile as-is, extend it via `ronin_active_igs` additions, subset it via removals, or override individual variables.

**`payer_baseline`** (default for CMS-0057-impacted payers):
- Active IGs: US Core + CARIN BB + HRex + PDex + PDex Plan Net + PDex Formulary + PAS + CRD + DTR + CDEx + SMART App Launch + Bulk Data + FHIR Terminology Services (the full 13-IG matrix from §1)
- Validation strictness: lenient (warn-not-fail on must-support gaps per ADR-0012 §3.4)
- MPI profile: payer per ADR-0012 §3.2
- Audit retention: 6 years (HIPAA default per CMS-2027 note §4.6)

**`provider_baseline`** (for healthcare provider deployments — future v1.x):
- Active IGs: US Core + HRex + CDEx + SMART App Launch + Bulk Data + FHIR Terminology Services
- PAS / CRD / DTR / CARIN BB / PDex / PDex Plan Net / PDex Formulary omitted (payer-side IGs)
- Validation strictness: lenient
- MPI profile: provider per ADR-0012 §3.2
- Audit retention: per customer policy
- Reflects the eventual healthcare-provider customer per ADR-0008 D7 (future v1.x; not v1 critical path)

**`strict_federal`** (for federal-payer-adjacent + state-payer deployments with elevated compliance posture):
- Active IGs: full payer_baseline matrix
- Validation strictness: strict (must-support gaps fail; SQL field checks block Bronze promotion; demographic-only matches always route to review per ADR-0012 §3.2 strict profile)
- MPI profile: strict per ADR-0012 §3.2
- Audit retention: customer-specified (typically 10+ years)
- Hard-deny guardrails enforced more aggressively (per ADR-0012 §3.4)
- All code system loadings require explicit license attestation, even for free-in-US systems
- Tamper-evident AuditEvent hash chain enabled (per CMS-2027 note §4.10)

**Customer extension patterns:**

- Use a profile as-is: `ronin_deployment_profile: payer_baseline` and nothing else.
- Add IGs to a profile: `ronin_active_igs: <profile-defaults> + [<custom-igs>]`.
- Subset a profile: `ronin_active_igs: <profile-defaults> - [<unwanted-igs>]`.
- Override profile defaults: explicit `ronin_active_igs`, `ronin_ig_versions`, `ronin_validation_strictness`, etc.
- Add net-new IGs not in the catalog: `ronin_extra_igs` per §8.

Profile composition is additive by default; explicit overrides win. Bundle validation catches incompatible combinations (e.g., activating CARIN BB without CARIN BB's required US Core version) at deploy time.

### 5. `ronin_licensed_systems` — code system loading (per cluster A)

Per the foundations note §3.2 and the CMS-2027 note §8.3–4 resolutions:

```yaml
# Default-on (Ronin ships loaders; bundle enables by default — free-in-US)
ronin_default_systems:
  - loinc
  - rxnorm
  - ndc
  - cvx
  - icd10cm
  - icd10pcs
  - hcpcs
  - snomed_us           # NLM-free; US Edition includes US extension
  - hl7

# Customer-discretion (Ronin ships loaders; bundle leaves OFF; opt-in via license attestation)
ronin_optional_systems:
  - cpt                 # Requires AMA license; install script prompts for attestation
  - x12_278             # Requires X12 license; install script prompts for attestation
  - snomed_international # If non-US deployment; affiliate license

# Active selection
ronin_licensed_systems:
  default: <ronin_default_systems>
  override: <customer-supplied list>
```

The `scripts/ronin-install.sh` install script prompts for license attestation before enabling CPT / X12_278 / SNOMED International loaders. Validator behavior on ValueSet bindings against unloaded systems: lenient warning (row promotes with `validation_warnings`); `strict_federal` profile fails. PAS workflow without X12 codes is degraded (FHIR-only PAS; X12 clearinghouse interop limited).

### 6. CI/CD upgrade rails — operational by 01/01/2027

**The 01/01/2027 deadline is the CI/CD-must-be-operational floor, not a version floor.** Customers can stay on the IG-floor versions indefinitely as long as the upgrade path stays exercised and verified.

CI/CD shape (per ADR-0013 §3 deployment posture):

1. **Weekly GitHub Actions schedule** on the Ronin source repository.
2. **Pull from packages.fhir.org** for each tracked IG canonical URL.
3. **Detect new published versions** for any tracked IG; mark as candidate.
4. **Run the validation-throughput POC + Inferno test suites** (§7 below) against a Standard-tier test workspace with the new IG version pinned.
5. **Auto-open a PR** against the source repo adding the new version to `ig_packages/` with test results.
6. **Customer-facing release** of the bundle includes the new version; customers adopt at their own pace via `ronin_ig_versions` override.

The CI/CD pipeline itself runs against Ronin's own test workspace, not customer workspaces. Customer-side IG version selection is per-deployment; customers can stay on 6.1.0 forever, climb annually, climb opportunistically when a new feature appears, etc.

**Per ADR-0013 §7 deployment sequence:** upgrading a deployment's IG version is a re-run of `databricks bundle deploy` with an updated `ronin_ig_versions` value. The validation transpiler (per ADR-0015) regenerates SQL artifacts; the Bronze→Silver Governance pipeline picks up the new artifacts on next execution; existing Bronze rows replay through the new validation at customer election (per validation-architecture note §7).

By 01/01/2027, the CI/CD pipeline must be operational. This is a Ronin engineering deliverable, not a customer deliverable.

### 7. Inferno test scope

v1 Ronin passes the following Inferno test kits, run as part of CI and pre-release verification:

- **Inferno US Core test kit** (version-matched to the active US Core pin per deployment profile)
- **Inferno CARIN BB test kit**
- **Inferno Da Vinci HRex + PDex + PAS + CRD + DTR test kits**
- **Inferno Da Vinci CDEx test kit** (provider_baseline only)
- **Inferno SMART App Launch test kit**
- **Inferno Bulk Data test kit**
- **Inferno PDex Plan Net + Formulary test kits** (payer_baseline only)

Plus **Touchstone** base FHIR R4 conformance test runs.

Test failures gate the CI/CD upgrade rails (§6). A new IG version that fails Inferno is held in a candidate state with a recorded failure pattern; customer adoption is gated until resolution.

Per-deployment Inferno run is a customer responsibility; Ronin provides the test-deployment recipe and the bundle's `ronin-test-deployment` profile.

### 8. Per-deployment IG extensions

Customers may carry custom IGs that profile US Core / HRex / etc. for state-specific or org-specific requirements. Examples: a state Medicaid managed-care IG profiling US Core Patient with state-program-required slicing; a payer's internal IG capturing custom claims-extension fields; a regional HIE-specific IG.

**Support model (standard FHIR Package per §2.2):**

- Customer obtains the FHIR Package `.tgz` from packages.fhir.org, simplifier.net, or builds it locally via the IG Publisher.
- Drops it into the deployment's `extra_ig_packages/` directory (or references via URL).
- Adds the canonical URL to `ronin_extra_igs` deployment variable:

```yaml
ronin_extra_igs:
  - canonical: "http://state-medicaid.example.org/fhir/managed-care"
    package: "extra_ig_packages/state-medicaid-mc-1.0.0.tgz"
  - canonical: "http://payer.example.com/fhir/custom-claims"
    package: "https://customer-artifactory.example.com/fhir-packages/custom-claims-2.1.0.tgz"
```

- `bundle deploy` reads the extras alongside the catalog.
- The validation transpiler (per ADR-0015) reads the extras and emits SQL artifacts.
- The CapabilityStatement (§10) reflects the extras.
- Custom-IG-aware activation: `ronin_active_igs` can reference the custom canonical URL just like a catalog IG.

**Caveats:**

- Inferno test kits don't cover customer-specific IGs (no kits exist); customer-side validation correctness is the customer's responsibility.
- Customer-supplied IGs that conflict with catalog IGs (same canonical URL, different version) produce a deploy-time error directing the customer to resolve.
- Custom IG dependency declarations must resolve against the catalog + extras combined.

Custom-IG support is a v1 feature; the per-deployment extension mechanism is designed in from the start via the standard FHIR Package surface (no Ronin-proprietary format).

### 9. Profile-claim version-mismatch policy

When a Bronze row's `meta.profile[]` references a profile version that doesn't match the deployment's active pin (e.g., row claims `us-core-coverage|9.0.0`; deployment pins `us-core-coverage|6.1.0`):

- **Major version downgrade** (row claims newer than deployment): warn-not-block. Validator emits WARNING; row promotes to Silver with `validation_warnings['version_downgrade']` annotation. Surfaces in observability.
- **Major version upgrade** (row claims older than deployment): warn-not-block. Validator runs against the deployment-active version; emits WARNING if constraints diverge meaningfully. Row promotes with annotation.
- **Profile chain cannot resolve at the loaded version**: blocks Gold promotion. Row stays in Silver with `silver_status='rejected'` for operator review.

Policy is configurable per deployment via `ronin_profile_version_mismatch_policy = "warn" | "block"`. Default is `warn`; `strict_federal` profile defaults to `block`.

### 10. CapabilityStatement generation

The TS App publishes a generated `/metadata` CapabilityStatement reflecting:

- The active IG matrix (`ronin_ig_versions` resolved).
- Supported resources per loaded IG.
- Supported operations (`$validate-code`, `$expand`, `$lookup`, `$translate`, `$match`, `$member-match`, `$export`, `$import`, `$everything`).
- Supported SMART scopes (per the loaded SMART App Launch version).
- Supported search parameters per resource per IG.
- The validation strictness (lenient / strict).
- The `match-grade` extension band mapping (per ADR-0012 §7.1 / OQ #7).

Generated at deployment time by a build-time script that reads the loaded IG packages + deployment configuration. Updated on `databricks bundle deploy` when IG versions or profile changes. Cached for fast `GET /metadata` serving.

The CapabilityStatement is also the authoritative source for Inferno test runs — Inferno reads it to discover which tests to run.

## Consequences

- **The v1 floor is conservative.** US Core 6.1.0 is 4 versions behind 9.0.0 (May 2026). The bundle ships every version; customers climb at their pace; CI/CD validates each climb. This matches real-world customer adoption patterns (most payers still on 6.1 or 7 as of late 2026 industry surveys).
- **CI/CD by 01/01/2027 is a Ronin engineering commitment.** It's not optional; it's the operational floor that lets customers stay on older IG versions without falling behind on validation correctness. The CI/CD pipeline is a v1 deliverable.
- **Bundle disk footprint grows.** ~150-250 MB for all IG packages; trivial for the bundle but worth tracking as the IG matrix expands. Versions older than 5 years can be archived from the active bundle (separate `ig_packages_legacy/` for long-tail customers).
- **Cross-IG version-incompatibility is a real concern.** CARIN BB 2.2.0 ↔ US Core 7+ is the canonical example. Bundle-validation catches at deploy time. Customers must understand the version-coordination story; documentation must surface clearly.
- **Three deployment profiles cover 90%+ of v1 customer scenarios.** `payer_baseline` = the 10M-member-payer target; `provider_baseline` = future provider expansion; `strict_federal` = the elevated-compliance subset. Per-deployment overrides handle the rest.
- **Custom IG support is a v1 feature, not a v1.x feature.** State Medicaid + custom payer IGs are common; supporting them in v1 removes a real adoption blocker.
- **Three layers of configurability cleanly separate catalog membership (Ronin) from activation (customer) from version pinning (customer).** Customers can subset, extend, or override the deployment profile without forking the bundle. New IGs are added via standard FHIR Package mechanism — no Ronin-engineering involvement required for customer-side additions.
- **Inferno conformance is a CI gate, not a release gate.** Test failures hold candidate versions; verified versions release. Customers running Inferno against their own deployments is a separate, customer-side concern.
- **The CapabilityStatement becomes a build-time artifact tied to deployment configuration.** Re-generated on every `bundle deploy`. Operationally a fast read but a non-trivial generation step at deploy time.

## Alternatives considered

- **Floor at latest published version (US Core 9.0.0 etc.).** Rejected — too aggressive; most customers can't adopt the latest within their compliance windows; breaks CMS-floor compatibility. The session-018 cluster B framing (floor at regulatory minimum + CI/CD upgrade rails) is the more honest customer-facing posture.
- **Ship only the floor version of each IG; require customers to source newer versions themselves.** Rejected — moves the package-management burden to customers; loses the bundle-validates-version-compatibility benefit; breaks the deployment-bootstrap "one command install" claim.
- **Manual customer-driven IG upgrades only (no CI/CD).** Rejected — by 01/01/2027 the upgrade path needs to be exercised continuously to surface incompatibilities before customers hit them in production. Manual is a customer-stuck story.
- **Validate via runtime-fetched IG packages (no bundling).** Rejected — runtime fetch from packages.fhir.org has SLA/availability risk; bundling makes deployments reproducible and air-gapped-deployable.
- **One unified default profile** instead of three. Rejected — the strictness and IG-set differences between payer / provider / strict_federal are substantial enough to warrant distinct defaults. Per-deployment overrides handle finer-grained customization.
- **Skip Inferno integration.** Rejected — Inferno conformance is what CMS / ONC effectively use to gauge compliance; integration into CI/CD is the customer-defensible posture.
- **Ship CapabilityStatement as a hand-written static artifact.** Rejected — IG version changes + deployment profile changes affect what's published; static won't track. Generated-at-deploy is the only consistent option.
- **Honor CMS-9115 floor (US Core 3.1.1) for backwards compatibility.** Rejected — CMS-0057 supersedes; the 3.1.1 ecosystem is end-of-life for new deployments. v2.x consideration if a legacy customer requirement materializes.

## Follow-up ADRs queued

- **ADR-0015: Validation Architecture** — ratifies the validation pipeline that consumes the IGs ratified here. Next ADR to draft.
- **ADR-0016: Audit and Access Transparency** — depends on the IG matrix for AuditEvent profile claims (per CMS-2027 compliance note §4).
- **ADR-0017: Terminology Service** — FHIR Terminology Services IG conformance per cluster E; depends on the IG matrix for code-system bindings.
- **Operability ADR** — CI/CD pipeline detailed mechanics, IG upgrade choreography, Inferno integration topology.
- **Customer onboarding script ADR (per ADR-0013 follow-ups)** — `scripts/ronin-install.sh` shape now includes the IG-version + licensed-system + deployment-profile prompts.

## Open questions not closed by this ADR

1. **CMS-9115 backwards compatibility** for v2.x — if a legacy customer requires US Core 3.1.1 floor, what's the bundle posture? Recommend: documented v2.x consideration; not v1.
2. **Inferno fail-but-acceptable** scenarios — some Inferno test failures are flaky or test-kit bugs rather than Ronin failures. Triage workflow for CI: human review on failure before blocking a candidate version. Belongs in operability.
3. **Customer-side Inferno run frequency** — should Ronin recommend monthly / quarterly Inferno runs against customer deployments? Document; not a regulatory requirement but a best practice.
4. **Custom IG validation completeness** — when a customer extends with a state-Medicaid IG, the validation transpiler emits SQL artifacts for it, but Inferno doesn't test it. What's the assurance story for custom-IG validation correctness? Per-customer responsibility; document.
5. **`ronin_extra_igs` package signing** — should customer-supplied IGs be required to be signed? Risk: malicious or buggy IGs could break the deployment. Signing adds operational complexity; not v1.
6. **Long-tail IG archive policy** — IGs older than 5 years move to `ig_packages_legacy/`; documented but not yet a v1 mechanism. v1.x or v2.

## Sources

- [CMS-0057-F factsheet](https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-prior-authorization-final-rule-cms-0057-f) — adopted IG versions
- [CMS-0057-F full text](https://www.cms.gov/files/document/cms-0057-f.pdf) — regulatory authority
- [Firely CMS-0057-F decoded](https://fire.ly/blog/cms-0057-f-decoded-must-have-apis-vs-nice-to-have-igs-for-2026-2027/) — IG-to-API mapping
- [US Core STU 9.0.0](https://build.fhir.org/ig/HL7/US-Core/) — latest US Core
- [CARIN BB Edition 2.2.0](http://standups.hl7.org/2026/03/27/unballoted-stu-update-publication-of-carin-consumer-directed-payer-data-exchange-carin-ig-for-blue-button-edition-2-2-0/) — rebased to US Core 7
- [Da Vinci HRex STU 1.1.0](http://hl7.org/fhir/us/davinci-hrex/) — foundational IG
- [Da Vinci PAS STU 2.1.0](https://hl7.org/fhir/us/davinci-pas/STU2.1/) — Prior Auth current production
- [Da Vinci CDEx STU 2.1.0](http://hl7.org/fhir/us/davinci-cdex/) — Clinical Data Exchange
- [HL7 Da Vinci 2026 status update](https://hl7news.hl7.org/2026/05/30/hl7-da-vinci-project-update/) — IG publication status
- [Foundations note §1.1](../research/2026-06-19-fhir-server-foundations.md) — IG ecosystem + dependency graph
- [CMS-2027 compliance note §3](../research/2026-06-19-cms-2027-compliance-landscape.md) — full IG matrix
- [ADR-0008 §D8](0008-updated-vision-and-scope.md) — narrow MDM v1 stance (informs strict_federal profile)
- ADR-0012 (MPI) §3.2 — three MPI deployment profiles inform the parallel IG-matrix deployment profile names here
- ADR-0013 (Deployment Posture) — CI/CD foundation + variable model

---

## Amendment 1 — Terminology anchor stack corrected (2026-06-20)

**Trigger:** During ADR-0017 drafting (session 019), the §1 IG matrix entry "FHIR Terminology Services IG 1.0.0" was found to reference an IG that does not exist as a published artifact with semantic-version releases. There is no `hl7.fhir.uv.terminology-service` package; what exists are three separate published artifacts that together define Ronin's terminology surface.

**Change:**

- The single `FHIR Terminology Services IG` row in the §1 IG matrix is replaced by three rows:
  - **FHIR core terminology operations** — pinned to FHIR R4 (4.0.1) for v1 Ronin; R5 / R6 forward path via `ronin_ig_versions` ratchet (§3). FHIR core defines `$validate-code`, `$expand`, `$lookup`, `$translate`, `$subsumes`, `$closure` and the CodeSystem / ValueSet / ConceptMap / NamingSystem resource shapes. Not a separate IG.
  - **FHIR Terminology Ecosystem IG** (`hl7.fhir.uv.tx-ecosystem`) — pinned to 1.9.1 continuous build (R5-based, requirements port back to R4). Defines server requirements: TerminologyCapabilities at `/metadata?mode=terminology`; mandatory parameters (`tx-resource`, `system-version`, `check-system-version`, `force-system-version`, `inferSystem`); optional but performance-critical `cache-id`; OperationOutcome error coding via `http://hl7.org/fhir/tools/CodeSystem/tx-issue-type`; the `x-caused-by-unknown-system` response parameter.
  - **HL7 Terminology (THO)** — package `hl7.terminology` pinned to 7.2.0. The content layer: v2 tables, v3 vocabularies, FHIR-published vocabularies, and stubs (`content = not-present`) for the licensed externals (SNOMED CT, LOINC, RxNorm, ICD, CPT, NDC, CVX, HCPCS). Pulled transitively via IG `package.json` dependencies — no separate `ronin_ig_versions` entry needed, but the dependency tree must include it.

- **`content = not-present` distinction surfaced.** THO stubs identify the system URL but carry no concepts. The Ecosystem IG forbids `$expand` and `$validate-code` against `content = not-present` CodeSystems. Loading THO does NOT satisfy validation against the licensed externals — the customer's licensed terminology load is still required. Encoded in ADR-0017 §7.

- **Cluster E (Terminology Services IG conformance commitment)** is reframed as conformance to the three-leg stack above. The intent is unchanged — Ronin conforms to the published FHIR terminology surface; the anchor names are now accurate.

- **Cluster B (SNOMED CT US 30-day delay) is unchanged.** The policy lives in the refresh choreography ratified in ADR-0017 §6; the cadence schedule is unchanged from ADR-0015 §10.

- **Deployment profile rows in §6 (`payer_baseline` / `provider_baseline`)** retain the phrase "FHIR Terminology Services" as shorthand for the three-leg stack. The phrase is now glossed by this Amendment; no further row-by-row edits needed.

**Why the original line was wrong:** during ADR-0014 drafting (session 018), the "FHIR Terminology Services IG" reference was carried over from earlier research notes that conflated the FHIR core terminology operations with a hypothetical IG. The Ecosystem IG was at 1.9.x-SNAPSHOT then (still is, now at 1.9.1); 1.0.0 was a placeholder that didn't correspond to any published artifact. The correction here resolves that without changing any of ADR-0014's downstream commitments.

**Cross-reference:** ADR-0017 §1 documents the same three-leg stack with the operational details Ronin commits to.
