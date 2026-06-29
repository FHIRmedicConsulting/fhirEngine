# ADR-0021: Install, Audit, and Runbooks — Hybrid Install Script, `installation_audit` Schema, Cost-Conscious Monitoring, Unified Operator CLI, `$everything` Gate Ratification, Educational-Materials Bundle Structure

- Status: **Accepted**
- Date: 2026-06-20
- Decider(s): Chad
- Session: 019
- Related: [ADR-0006](0006-smart-on-fhir-and-udap-security.md), [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md), [ADR-0010](0010-storage-shape.md), [ADR-0011](0011-write-contract.md), [ADR-0012](0012-master-patient-index.md), [ADR-0013](0013-deployment-posture.md), [ADR-0014](0014-conformance-targets-and-ig-matrix.md) §3, [ADR-0015](0015-validation-architecture.md) (Amendment 2), [ADR-0016](0016-audit-and-access-transparency.md) §5.2 + §5.3, [ADR-0017](0017-terminology-service.md) §6, [ADR-0018](0018-patient-portal-consent-and-read-time-filter.md) §5 + §10, [ADR-0019](0019-storage-and-pipeline-operations.md), [ADR-0020](0020-cicd-and-conformance-test-orchestration.md)

## Context

ADR-0019 closed the storage + pipeline mechanics; ADR-0020 closed the release engineering pipeline. ADR-0021 closes the customer-facing operations contract: how an administrator installs Ronin, how administrative decisions get audited, what the operator's day-to-day interface looks like, what runbooks ship, and how the system behaves under operations and edge cases.

Six clusters fold in: install script (O11), `gold.installation_audit` schema (O7), monitoring + alerting + on-call (O4), App lifecycle runbooks (O8), `$everything` gate semantics (O12), educational materials content-bundle structure (O13). Across these, the recurring frame is **cost-conscious customer experience** — minimize infrastructure customers have to stand up, reuse Databricks-native primitives, expose operator surfaces through one consistent CLI, document everything in the bundle so it ships alongside the code.

Several upstream ADRs deferred concrete mechanics here:

- ADR-0013 — App restart / update / log streaming / networking runbooks.
- ADR-0014 §3 — `ronin_ig_versions` ratchet operator workflow.
- ADR-0015 Amendment 2 + ADR-0017 §6 + ADR-0019 §9 + ADR-0020 §8 — operator-pull activation flows for each component (now unified in §9 below).
- ADR-0016 §5.2 — administrator-decision audit schema.
- ADR-0016 §5.3 — breach-signal alerting topology.
- ADR-0018 §5 + §10 — `$everything` gate behavior + educational materials structure.

## Decision

### 1. `scripts/ronin-install.sh` shape — hybrid interactive + config-file replay

Install runs in three modes:

| Mode | Trigger | Behavior |
|---|---|---|
| **Fresh interactive** | First run; no `ronin-install.yaml` in CWD | Walks admin through every variable; prompts include sensible defaults; emits `ronin-install.yaml` capturing all selections; runs the install plan |
| **Replay** | `ronin-install.yaml` present | Reads selections; runs the install plan; no prompts; ideal for repeat installs across dev/staging/prod environments |
| **Update** | `--update` flag + existing install detected | Reads existing config from `gold.installation_audit`; prompts only for new variables added since last install; updates the install plan |

#### 1.1 Prompts (fresh interactive)

```
Welcome to Ronin install.

Catalog          [ronin]:
Schema           [main]:
Warehouse name   [ronin-warehouse]:
Warehouse size   [Small]:
App name         [ronin]:
Patient portal   [themed | headless]: themed
Deployment profile [payer_baseline | provider_baseline | strict_federal]: payer_baseline

IG versions:
  US Core              [6.1.0]: 6.1.0
  CARIN BB             [2.0.0]: 2.0.0
  ... (per ADR-0014 §1 matrix)

Licensed code systems (comma-separated): LOINC,SNOMED-CT-US,RxNorm,ICD-10-CM,NDC,CVX,HCPCS
  [License attestation prompt for each — see §2.1]

NLM UMLS API key (for VSAC + SNOMED CT US): ****
DirectTrust UDAP additional CAs (optional): []
UDAP mode (inline | delegate): inline
Educational materials bundle URI: /Volumes/ronin/customer_assets/educational-materials-en/
Alert webhook URL (optional): https://customer.pagerduty.com/integration/...

[Confirm + apply (y/n)]:
```

All selections write to `ronin-install.yaml` AND to `gold.installation_audit` via §2.

#### 1.2 Install plan steps (idempotent)

```
1. Prerequisites check:
   - Databricks CLI installed
   - Active Databricks profile authenticated
   - Workspace has Unity Catalog enabled
   - Target catalog exists OR admin has CREATE CATALOG grant
2. Catalog + schema setup (no-op if exists).
3. SQL warehouse creation (or bind to existing per ADR-0013 deployment-bootstrap POC).
4. Service principal creation + grant configuration.
5. Secret creation (NLM key, alert webhook, customer-supplied IdP secrets).
6. DAB deploy (the four-resource bundle from ADR-0013 + the three DLT pipelines from ADR-0019 + the portal App from ADR-0018).
7. Bundle artifact verification (signature check; expected-hash check).
8. Smoke tests (per ADR-0020 smoke tier).
9. Initial IG activation per `ronin_ig_versions`.
10. Initial terminology load + activation per ADR-0017 §6.
11. License attestation capture per §2.1.
12. Install completion event written to `gold.installation_audit`.
```

Each step is idempotent and recoverable. Failure mid-step → install resumes from the last completed step on retry; `--force-restart` blows away state and starts over.

### 2. `gold.installation_audit` schema

```
ronin_<warehouse>.gold.installation_audit

installation_audit_id    STRING NOT NULL    -- UUID v4 minted at write
event_time               TIMESTAMP NOT NULL
event_type               STRING NOT NULL    -- see §2.1 catalog
operator_principal       STRING NOT NULL    -- UC service principal or user
component                STRING             -- which subsystem the event touched
prior_value              STRING             -- nullable; before-state (JSON-serialized)
new_value                STRING             -- nullable; after-state (JSON-serialized)
attestation_text         STRING             -- nullable; full attestation text for license + compliance
notes                    STRING             -- operator-supplied free-text
correlation_id           STRING NOT NULL    -- groups events from a single install or activation run
schema_version           STRING NOT NULL    -- this table's own schema version for evolution per ADR-0019 §1
```

Partition: `year_month(event_time)`. ZORDER: `(event_type, component)`. Retention: **indefinite** (regulatory + tamper-evidence per ADR-0016).

#### 2.1 Event type catalog

| event_type | When written | `attestation_text` required |
|---|---|---|
| `install_started` | Step 1 of §1.2 | No |
| `install_completed` | Step 12 of §1.2 | No |
| `install_failed` | Any step failure | No |
| `install_rollback` | Operator-triggered or auto-rollback after failure | No |
| `uninstall` | Operator-triggered `ronin uninstall` | Yes — uninstall confirmation |
| `variable_set` | Each install-time variable selection | No |
| `ig_activated` | `ronin activate ig <version>` per ADR-0014 §3 | No |
| `terminology_activated` | `ronin activate terminology <kind> <url> <version>` per ADR-0017 §6 | No |
| `mpi_activated` | `ronin activate mpi <model_version>` per ADR-0019 §9 | No |
| `dlt_activated` | `ronin activate dlt <pipeline_name> <version>` per ADR-0019 + ADR-0020 §8 | No |
| `validator_activated` | `ronin activate validator <version>` per ADR-0020 §8 | No |
| `trust_bundle_activated` | `ronin activate trust-bundle <version>` per ADR-0006 §9 | No |
| `consent_policy_activated` | Custom consent policy ratified (rare; v1.x candidate) | No |
| `sls_rules_activated` | `ronin activate sls-rules <version>` per ADR-0015 Amendment 2 §A2.4 | No |
| `secret_rotated` | `ronin rotate <secret_name>` | No |
| `license_attested` | Per-CodeSystem license attestation during install or refresh | **Yes** — full license text + attesting party |
| `client_supplied_id_override_attested` | Customer enables PHI in fhir_ids per ADR-0010 §5 (HIPAA risk warning) | **Yes** — HIPAA-risk acknowledgement text |
| `headless_portal_attested` | Customer running `ronin_patient_portal = headless` attests their portal meets CMS-0057 obligations per ADR-0018 §9 | **Yes** — CMS-0057 compliance attestation text |
| `consent_recorded_by_staff` | Operator records Consent on behalf of patient via §1 admin endpoint per ADR-0018 §8 | No (Consent body itself in `gold.consent_r4_current`; pointer here) |

The `installation_audit` table is the regulatory truth surface for "who did what when" at the administrative level. Per-FHIR-resource access stays in `AuditEvent` (per ADR-0016 §1 surface 1); operational metrics stay in `gold.observability.*` (per §10).

#### 2.2 Tamper-evidence

Per ADR-0016 §4: append-only Delta + UC RBAC restricting write access to the install SP + designated operators + transaction log retained for 24 months minimum. The `correlation_id` groups events from a single install run, allowing forensic reconstruction.

### 3. Monitoring + alerting topology — cost-conscious Databricks-native

| Layer | Source | Storage | Surface |
|---|---|---|---|
| Runtime metrics | Databricks `system.*` tables (workspace, SQL, jobs, DLT) | Databricks-managed | Materialized to `gold.observability.*` via DLT pipeline |
| App-level metrics | Apps emit structured JSON logs to App log streaming | DLT pipeline reads + materializes | `gold.observability.app_request_log` |
| Pipeline health | DLT pipeline run records (per ADR-0019 §5) | `gold.observability.dlt_pipeline_run` | Operator dashboard + alerts |
| Refresh job status | Terminology refresh, SLS re-classification, trust bundle refresh, MPI retraining | `gold.observability.refresh_job_run` | Operator dashboard + alerts |
| Breach signals | OAuth event log breach pattern detection (per ADR-0016 §5.3) | `gold.oauth_breach_signal` (already in ADR-0016) | Alert routing per §4 |
| Stewardship SLO status | MPI stewardship queue + SLA tracking per ADR-0019 §9 | `gold.observability.stewardship_slo_status` | Operator dashboard + alerts |

**Dashboards**: Databricks SQL dashboards shipped in the DAB at `resources/dashboards/`:

- `ops-overview` — install status, pipeline health, refresh job status, current alert count.
- `compliance-snapshot` — IG version pins, terminology pins, validator version, conformance evidence URL for the active version (per ADR-0020 §11), license attestations.
- `audit-explorer` — `installation_audit` + AuditEvent queryable by event_type / operator / time.
- `mpi-stewardship` — review queue size, SLO breach count, model version + last EM retrain.
- `breach-monitor` — `gold.oauth_breach_signal` summary + active alerts.

Customer can build additional dashboards on top via standard Databricks SQL.

**Alerting**: customer supplies webhook URL via `ronin_alert_webhook`. No Ronin-side paging infrastructure. Webhook contract per §5.

### 4. Breach-signal alerting hooks

Per ADR-0016 §5.3, breach patterns map to alert severities:

| Pattern | Severity | Default response |
|---|---|---|
| `brute_force` | **P2** | `alert_only` (per `ronin_breach_response.brute_force`) |
| `credential_stuffing` | **P1** | `rate_limit_subject` (auto) + webhook fire |
| `scope_escalation` | **P1** | `revoke_tokens` (auto) + webhook fire |

`strict_federal` profile tightens these per ADR-0016 §5.3 cluster-Q7.

#### 4.1 Auto-resolve heuristics

- A breach signal whose underlying activity stops (no failed auths from same IP/subject for 24h) auto-resolves; webhook receives resolve event.
- Manual resolution via `ronin breach resolve <signal_id>` writes resolution to `gold.oauth_breach_signal` + closes the alert.
- Resolution history tracked for forensic review.

#### 4.2 False-positive suppression

- `ronin_alert_suppression_clients` array of known-good client_ids excluded from pattern detection (e.g., the customer's own monitoring client; legitimate user-app refresh cycles).
- Per-pattern suppression: a known refresh-token-cycle pattern that's legitimate can be added to `ronin_alert_suppression_patterns`.
- Suppression list versioned in `gold.installation_audit` via `variable_set` events.

### 5. On-call paging integration — customer-supplied webhook

Customer supplies one or more webhook URLs via `ronin_alert_webhooks` (list of `{name, url, severity_filter}`). Standard webhook payload:

```json
{
  "ronin_version": "1.0.3",
  "alert_id": "uuid",
  "severity": "P1 | P2 | P3 | P4",
  "source": "breach_signal | dlt_pipeline_failure | refresh_job_failure | stewardship_slo_breach",
  "signal": {...},
  "correlation_id": "uuid",
  "fired_at": "2026-06-20T18:00:00Z",
  "ack_url": "/api/alerts/{alert_id}/ack",
  "resolve_url": "/api/alerts/{alert_id}/resolve",
  "suggested_action": "string",
  "evidence_url": "https://.../ronin/audit/{correlation_id}"
}
```

Templates shipped in `docs/operability/alerting-templates/`:

- `pagerduty-events-api-v2.md` — PagerDuty Events v2 payload mapping.
- `opsgenie-webhook.md` — Opsgenie integration.
- `datadog-event.md` — Datadog events endpoint.
- `splunk-hec.md` — Splunk HTTP Event Collector.
- `sentinel-data-collector.md` — Microsoft Sentinel custom log ingestion.
- `generic-json.md` — plain JSON POST for custom on-call systems.

Customer chooses one or multiple per severity tier. Severity routing (`severity_filter`) lets customers send P1+ to PagerDuty and all severities to Datadog, etc.

### 6. App lifecycle runbooks

All in `docs/operability/runbooks/` (shipped in bundle; mounted to operator UC volume per §12). Per-runbook structure:

```
# Runbook: <title>

## Symptoms
What the operator sees.

## Diagnosis steps
Ordered checks to confirm the failure mode.

## Resolution
Concrete steps.

## Verification
How to confirm the fix.

## Post-mortem template
Slot for the post-mortem doc.

## Related runbooks
Cross-references.
```

v1 runbooks:

- `app-restart-procedure.md` — App restart (FHIR server + Patient portal).
- `app-update-procedure.md` — App update via DAB redeploy (zero-downtime per Databricks App's blue-green deploy pattern).
- `app-log-streaming-setup.md` — Per ADR-0013 App log streaming integration.
- `app-networking-troubleshooting.md` — App egress + ingress + IdP connection diagnosis.
- `partial-deploy-failure-recovery.md` — Bundle deploy mid-failure recovery.
- `dlt-pipeline-failure-recovery.md` — DLT pipeline restart + state-recovery.
- `refresh-job-failure-recovery.md` — Terminology / trust-bundle / MPI refresh failures.
- `secret-rotation-procedure.md` — NLM key + customer IdP secrets rotation.
- `mpi-stewardship-overflow.md` — Stewardship queue management when SLO breached.
- `breach-signal-investigation.md` — Forensic walkthrough for P1 breach signals.
- `consent-revocation-emergency.md` — Patient-requested emergency consent revocation across all granted scopes.
- `license-attestation-renewal.md` — Annual license attestation renewal for licensed CodeSystems.

Per-version runbooks; updated alongside the bundle. Customers can override or extend in their UC volume.

### 7. `$everything` operation gate — operation-level scope + per-resource gate

Ratifies the ADR-0018 §5 open question.

For `GET Patient/{id}/$everything`:

1. **Operation-level scope check** (point 1 of ADR-0006 §5): caller needs one of:
   - `patient/*.rs` (user-context, all resources read+search)
   - `system/*.rs` (system-context, all resources)
   - `user/Patient.$everything` (operation-specific; v1.x)
2. **Patient compartment filter** (point 4): patient_id resolved from `{id}` or `launch_context.patient`.
3. **Per-result-resource gate** (point 5; ADR-0018 §5): each resource in the candidate Bundle evaluated against active Consents + multi-level security + claimed PPOU.
4. **Bundle assembly**: only resources that pass §5's gate are included in the returned Bundle.
5. **`OperationOutcome` warning** (added to the Bundle): if any resources were excluded, the warning describes the redaction categories — *not* per-resource enumeration (which would leak existence). Example: "Some resources excluded due to active Consent provisions. Categories affected: behavioral health, substance use disorder."

This matches ADR-0018 §5's per-row gate model; clients see a useful response degradation without leakage of redacted resources.

Edge cases:
- **All resources excluded**: return an empty `entry[]` Bundle with the warning; status 200 (operation succeeded; result set is empty).
- **No active Consents and lenient strictness**: pass through to the standard scope check; gate is no-op.
- **Consent.provision.actor matches caller but provision is `deny` for sensitivity X**: standard gate logic applies; only sensitivity-X resources excluded; rest pass.

### 8. Educational materials content-bundle structure

Path: from `ronin_educational_materials_bundle_uri` (deployment variable per ADR-0018 §10). Default structure:

```
<bundle_uri>/
├── manifest.yaml
├── en/
│   ├── provider-access-overview.md
│   ├── payer-to-payer-overview.md
│   ├── your-rights.md
│   ├── how-to-opt-out.md
│   ├── how-to-authorize-transfer.md
│   ├── data-categories-explained.md      (HCS confidentiality + sensitivity for patients)
│   ├── what-is-a-smart-app.md
│   └── images/
├── es/                                    (Spanish; optional)
├── ... (per-language directories)
└── overrides/                             (customer can replace any file by mirroring the path)
```

#### 8.1 `manifest.yaml`

```yaml
languages:
  - code: en
    display: English
    default: true
  - code: es
    display: Español

required_pages:
  - provider-access-overview
  - payer-to-payer-overview
  - your-rights
  - how-to-opt-out
  - how-to-authorize-transfer

optional_pages:
  - data-categories-explained
  - what-is-a-smart-app

jurisdictions:
  - code: hipaa
    display: HIPAA baseline
  - code: 42-cfr-part-2
    display: 42 CFR Part 2 (substance use)
  - code: state-behavioral
    display: State behavioral health
```

Required pages must be present in at least one language. Optional pages render only if present. Customer overrides replace individual files; the manifest controls which are required vs. optional per deployment.

Ronin ships a default English bundle as the **starting point**; customers customize via override or replace wholesale. Per ADR-0018 §10, content responsibility is the customer's; Ronin provides the structure.

#### 8.2 Portal rendering convention

Portal renders at URLs per ADR-0018 §10:

```
/portal/learn/provider-access      → en/provider-access-overview.md (or per-language)
/portal/learn/payer-to-payer       → en/payer-to-payer-overview.md
/portal/learn/your-rights          → en/your-rights.md
/portal/learn/data-categories      → en/data-categories-explained.md  (if present)
```

Language selection per session via `Accept-Language` header or explicit picker.

### 9. Unified operator CLI

Single `ronin` CLI surface across all operator-pull activation flows from ADR-0014 / ADR-0017 / ADR-0018 / ADR-0019 / ADR-0020.

```
# Activation
ronin activate <component> <version> [--profile <name>] [--rollback-window <duration>]
   <component>: ig | terminology | mpi | dlt | validator | trust-bundle |
                consent-policy | sls-rules

# Status + diff
ronin status [--component <name>]
ronin diff <component> <candidate_version>
ronin rollback <component>

# Refresh (operator-pulled refresh of upstream sources)
ronin refresh <component>                  -- terminology | trust-bundle | ig
ronin refresh-status                       -- in-flight refresh jobs

# Health + audit
ronin health
ronin audit query --since <ts> [--event-type <type>] [--component <name>] [--operator <principal>]

# Install + uninstall
ronin install [--config <path>] [--update] [--force-restart]
ronin uninstall

# Patient consent (back-office surface per ADR-0018 §8)
ronin consent record <patient_id> --provision <yaml_path>
ronin consent revoke <consent_fhir_id>

# Operations
ronin breach list [--severity <p1|p2|p3|p4>] [--status <open|resolved>]
ronin breach resolve <signal_id>

# Self-update
ronin self-update                         -- pulls new CLI version per current bundle
```

Every command writes a `gold.installation_audit` event with `correlation_id` grouping multi-step operations.

#### 9.1 Optional admin tab in Patient Portal App

Per ADR-0018 §3, the Patient Portal App surfaces the same operations via a UI admin tab (scoped to operator users via SMART scope `user/Operator.*`). CLI remains the canonical interface; UI is a convenience surface. v1.x candidate to add operator-portal as a separate App (per ADR-0018 §8 follow-up).

### 10. Metrics storage

Tables in `ronin_<warehouse>.gold.observability.*`:

| Table | Source | Retention | Partition |
|---|---|---|---|
| `app_request_log` | App-emitted JSON logs | 24 months | `year_month(event_time)` |
| `dlt_pipeline_run` | DLT system tables → materialization | 24 months | `year_month(start_time)` |
| `refresh_job_run` | Refresh job system tables → materialization | 24 months | `year_month(start_time)` |
| `breach_signal` | Pointer/projection of `gold.oauth_breach_signal` per ADR-0016 §5.3 | Indefinite | `year_month(detected_at)` |
| `stewardship_slo_status` | MPI stewardship queue tracker | 24 months | `year_month(measured_at)` |
| `installation_audit_summary` | Materialized aggregates from `gold.installation_audit` for dashboard performance | Indefinite | `year_month(window_start)` |

Per ADR-0019 §2: weekly OPTIMIZE for these tables; daily for the high-write `app_request_log`.

The observability DLT pipeline (a fourth DLT pipeline added by this ADR on top of ADR-0019 §5's three) reads from Databricks system tables + App log streaming + breach signals and materializes the above.

### 11. Customer-facing CLI distribution

The `ronin` CLI ships as a Python package:

- **Distribution**: included in the DAB bundle as `ronin-cli-<version>.whl` at a UC volume path.
- **Install at install-time**: `scripts/ronin-install.sh` installs the CLI via `uv pip install` (or `pip install`) into a dedicated venv at `~/.ronin/venv`; symlinks `ronin` into the operator's PATH.
- **Platforms**: macOS (Intel + ARM), Linux (x86_64 + aarch64), Windows via WSL (per ADR-0013 install posture).
- **Self-update**: `ronin self-update` reads the active bundle version from `gold.installation_audit`, downloads the matching CLI wheel, replaces the venv. Operator-pulled; no auto-update.
- **CLI version pinned to bundle version**: prevents skew between CLI features and server features. `ronin --version` reports both.

### 12. Runbook + docs structure

`docs/operability/` directory ships in the DAB; deployed to UC volume at install-time for offline operator access.

```
docs/operability/
├── runbooks/                          (§6)
├── alerting-templates/                (§5)
├── dashboards/                        (references to §3 SQL dashboards)
├── idp-playbooks/                     (per ADR-0020 §4 on-demand IdP playbooks)
├── reference/
│   ├── installation-audit-event-catalog.md
│   ├── observability-tables-schema.md
│   ├── cli-reference.md               (auto-generated from §9)
│   └── deployment-profiles.md
└── README.md                          (operability entry point)
```

Per-version docs preserved alongside per-version bundle artifacts (per ADR-0020 §11 conformance evidence pattern). Operators can offline-access via UC volume mount.

## Consequences

**What this commits Ronin to:**

- A single operator CLI surface across all eight activation components — a stable contract for the next major-version horizon.
- `gold.installation_audit` is a permanent regulatory truth table; schema can evolve (per ADR-0019 §1) but events never delete.
- Cost-conscious monitoring posture: customer brings the on-call infrastructure; Ronin brings the Databricks-native dashboards + observability tables.
- App lifecycle runbooks ship in the bundle and update per release — version-pinned, offline-accessible.
- Educational materials are a customer-content responsibility; Ronin provides structure + default English starting point.
- `$everything` operation degradation is per-resource (matches ADR-0018 §5); clients see useful empty Bundle + `OperationOutcome` warning, not 403.

**What it enables downstream:**

- Marketplace listing publication ADR can reference the conformance evidence URL pattern (per ADR-0020 §11) + per-version runbook URL pattern from §12.
- First-customer install becomes runnable end-to-end: §1 install script → §2 audit table → §3 dashboards → §6 runbooks → §9 operator CLI.
- TEFCA participation ADR can reference §2 attestation schema for QHIN onboarding attestations.
- ADR-0019 §6 + §9 tuning constants land as Amendment when POCs unblock; operator workflow already designed.

**What it costs:**

- Twelve sections in one ADR — large surface; operator-facing complexity. Mitigated by the unified CLI in §9 collapsing eight subsystem-specific commands into one consistent shape.
- The CLI auto-update path adds a new attack surface (downloads). Mitigated by signature verification + operator-pull (no auto-update without explicit operator command).
- Customer-supplied alert webhook means Ronin engineering has to support N customer integrations through templates; mitigated by the standard JSON payload + per-customer template generation.
- Educational materials are a customer responsibility — smaller payers may need help building content; documented as the customer's content team owning this surface.

## Alternatives considered

- **Pure declarative install (no interactive mode)** — rejected per §1. First-install operators benefit from prompts; experienced operators use replay mode.
- **Ronin-hosted paging infrastructure** (Ronin owns the alert routing) — rejected. Coupling Ronin to a SaaS paging surface increases the operational footprint and pulls Ronin into customer security-tooling decisions; customer-supplied webhook is the right boundary.
- **Per-component CLIs** (`ronin-ig`, `ronin-terminology`, `ronin-mpi`...) — rejected. Operator learns one tool; one audit surface; one help text discovery flow.
- **`$everything` reject-on-any-consent-restriction** — rejected per §7. Per-resource degradation matches ADR-0018 §5; consistent with the rest of the gate.
- **Mandatory English-only educational materials** — rejected per §8. Manifest supports per-language; customers in non-English jurisdictions need to ship localized content.
- **Auto-update operator CLI** — rejected per §11. Operator-pull mirrors the rest of the activation pattern (ADR-0014 / ADR-0017 / ADR-0019 / ADR-0020).
- **No `installation_audit` table; reuse `AuditEvent`** — rejected per §2. AuditEvent is reserved for PHI-touching access per ADR-0016 §3.1; administrative decisions are a separate audit concern with different retention + RBAC.
- **App lifecycle runbooks as wiki pages** — rejected per §6 + §12. Bundle-shipped + UC-volume-mounted means offline access + version-pinning + customer override.

## Follow-up ADRs queued

- **Marketplace listing publication ADR** (queued from ADR-0013) — uses ADR-0020 §11 + §12 as the artifact pipeline.
- **Operator portal App** — per ADR-0018 §8 v1.x follow-up; UI for §9 CLI operations.
- **TEFCA participation ADR** — uses §2 attestation schema for QHIN onboarding events.
- **Customer onboarding script ADR** (queued from ADR-0013) — `scripts/ronin-install.sh` final shape ratified here; per-cloud onboarding wrappers (Azure / AWS / GCP Marketplace SaaS Offers) live in the queued onboarding ADR.
- **DAR + clinical-plausibility DQ rules taxonomy** (queued; multi-session discovery thread) — per-rule structure may extend §10 observability tables.
- **OpenTofu module ADR** — non-Databricks bits (SFTP storage, cloud-provider event notifications, OAuth IdP wiring) — install flow from §1 calls OpenTofu modules; concrete module shape lives in the queued ADR.
- **CLI scriptability ADR** (v1.x) — `--json` output mode + machine-readable status for CI integration.

## Open questions not closed by this ADR

- **Per-cloud install wrapper scripts** — `scripts/ronin-install.sh` is the unified entry point, but cloud-marketplace SaaS Offer installation flows have per-cloud nuances (Azure ARM templates, AWS CloudFormation, GCP Deployment Manager) that live in the customer onboarding ADR.
- **Multi-tenant operator surface** — when a single Ronin install hosts multiple payer tenants, the operator CLI needs `--tenant` scoping. Out of scope for v1; revisits when multi-tenancy lands.
- **Stewardship workflow UI** — §9 CLI exposes operations; some MPI stewardship workflows benefit from a UI for batch operations. Likely v1.x operator-portal-App ADR.
- **Compliance-positioning UDAP narrative** (deferred from ADR-0006) — marketing concern; not an architecture decision; lives in the GTM track.
- **Customer-supplied dashboard template library** — Ronin ships five base dashboards (§3); a customer-template marketplace within the Ronin ecosystem could ease deployment of common reporting needs. v1.x candidate.

## Sources

- [Databricks System Tables](https://docs.databricks.com/aws/en/admin/system-tables/) — runtime metrics source per §3
- [Databricks SQL Dashboards](https://docs.databricks.com/aws/en/dashboards/) — dashboard primitive
- [Databricks Asset Bundles — Resource Types](https://docs.databricks.com/aws/en/dev-tools/bundles/resources.html) — `databricks_dashboard` resource
- [PagerDuty Events API v2](https://developer.pagerduty.com/docs/events-api-v2-overview) — webhook contract per §5
- [Opsgenie Webhook Integration](https://support.atlassian.com/opsgenie/docs/integrate-opsgenie-with-incoming-webhook/) — webhook contract per §5
- [Datadog Events API](https://docs.datadoghq.com/api/latest/events/) — webhook contract per §5
- [Splunk HTTP Event Collector](https://docs.splunk.com/Documentation/Splunk/latest/Data/UsetheHTTPEventCollector) — webhook contract per §5
- [Microsoft Sentinel Data Collector API](https://learn.microsoft.com/en-us/azure/sentinel/connect-rest-api-template) — webhook contract per §5
- [FHIR R4 `Patient/$everything`](https://hl7.org/fhir/R4/operation-patient-everything.html) — operation spec for §7
- ADR-0006 — operator-pull pattern for trust bundle activation
- ADR-0010 — Patient compartment used by §7 `$everything`
- ADR-0013 — App lifecycle source for §6 runbooks
- ADR-0014 §3 — IG activation pattern unified in §9
- ADR-0015 Amendment 2 — SLS activation pattern unified in §9
- ADR-0016 §5.2 + §5.3 — installation_audit table requirement + breach signal source for §4
- ADR-0017 §6 — terminology activation pattern unified in §9
- ADR-0018 §5 + §8 + §10 — `$everything` open question + back-office consent + educational materials
- ADR-0019 — pipeline activation patterns + observability table location decisions
- ADR-0020 — release flow that publishes per-version runbooks + dashboards
