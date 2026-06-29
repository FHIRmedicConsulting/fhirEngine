# ADR-0016: Audit and Access Transparency — AuditEvent + Application Log + SMART OAuth Events + Lakehouse-Native Federated-Store Resolution

- Status: **Accepted**
- Date: 2026-06-19
- Decider(s): Chad
- Session: 018
- Related: [ADR-0008](0008-updated-vision-and-scope.md), [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md), [ADR-0010](0010-storage-shape.md) (Amendment 3), [ADR-0011](0011-write-contract.md) (Amendment 3), [ADR-0012](0012-master-patient-index.md), [ADR-0013](0013-deployment-posture.md), [ADR-0014](0014-conformance-targets-and-ig-matrix.md), [ADR-0015](0015-validation-architecture.md), [docs/research/2026-06-19-cms-2027-compliance-landscape.md](../research/2026-06-19-cms-2027-compliance-landscape.md), [docs/research/2026-06-19-fhir-server-foundations.md](../research/2026-06-19-fhir-server-foundations.md)

## Context

The cumulative CMS-0057 API set live by 01/01/2027 (Patient Access, Provider Access, Payer-to-Payer, Prior Authorization) generates ~10-100× the access volume of pre-FHIR payer systems. At 10M-member-payer scale: ~10 Patient Access queries/member/year + ~50 Provider Access calls/provider/year × ~50K providers + bulk exports across Payer-to-Payer transitions = **billions of AuditEvent rows per year** at the upper bound.

Audit at this scale is load-bearing for:

- **HIPAA Security Rule** compliance — auditable access; retention sufficient to satisfy audit requirements.
- **Patient access transparency** — the Patient Access API spec encourages member-visible "who accessed your data" views; the FHIR `AuditEvent` resource is the canonical substrate.
- **Breach detection** — pattern detection on access logs; failed-auth signal aggregation.
- **TEFCA QHIN participation** — cross-org audit export per QHIN policy.
- **Operational debugging** — perf + error investigation via application access logs.
- **SIEM integration** — customer security teams ingest audit data into Splunk / Sentinel / Datadog / similar.

**The federated-store problem this ADR resolves.** Postgres-backed FHIR stores (notably Azure Health Data Services) have documented capacity limits on AuditEvent (and other high-volume resources) that force enterprise customers into **multi-FHIR-store federation patterns** — partitioning patient populations across separate stores, then layering cross-store query infrastructure on top. The workarounds are operationally complex (broken referential integrity, audit consolidation gymnastics, multi-store SMART OAuth) and drive multi-million-dollar consulting engagements. **Ronin on Delta sidesteps this entirely** — append-only Delta tables partitioned by `(year_month(recorded), patient_hash_bucket(patient_id))` scale to billions of rows in a single workspace; cross-resource queries use the same compartment + index machinery as everything else; no federation required. This is a key competitive differentiator (per session-018 cluster F) and a positioning anchor for Ronin's Marketplace listing + Partner-ecosystem narrative.

Session-018 clusters F (AuditEvent + federated-store positioning) and G1 (Patient transparency rate limit) lock the v1 posture. This ADR ratifies the architecture.

## Decision

### 1. Five distinct audit surfaces

Ronin v1 generates audit across five surfaces, each with a distinct purpose and consumer:

| Surface | Purpose | Format | Consumer |
|---|---|---|---|
| **FHIR AuditEvent** | Spec-canonical access audit; queryable via FHIR REST; patient-facing transparency | FHIR R4+ resource | Patients, operators, regulators, SIEM (via `$export`) |
| **Application access log** | HTTP-level request/response; latency, status, request id | Structured JSON / Delta | Operators, SRE, SIEM, debugging |
| **SMART OAuth event log** | Token issuance, refresh, revocation, failed-auth | Structured JSON / Delta | Security teams, SIEM, breach detection |
| **Provenance** | Clinical-data lineage (per ADR-0012 §8) | FHIR R4+ resource | Clinical data consumers, regulators |
| **Governance audit** | Bronze→Silver→Gold transformation lineage (per ADR-0010 Amendment 3 `audit_trail`) | Embedded STRUCT on Silver rows | Operators, replay/reprocessing, transpiler upgrade investigation |

All five surfaces are first-class data; all live in UC; all queryable via Spark SQL; all participate in customer-side governance.

### 2. AuditEvent tables across Bronze/Silver/Gold (per Amendment 3 tier model)

`AuditEvent` is a first-class FHIR resource. Per ADR-0010 Amendment 3, it has tables in all three tiers:

```
ronin_<warehouse>.bronze.audit_event_r4
ronin_<warehouse>.silver.audit_event_r4
ronin_<warehouse>.gold.audit_event_r4
ronin_<warehouse>.gold.audit_event_r4_current  -- Layer 3 current-version projection
```

**Schema** (Gold; canonical FHIR AuditEvent body):

```
fhir_id              STRING NOT NULL
version_id           BIGINT
last_updated         TIMESTAMP
fhir_version         STRING
patient_id           STRING               -- denormalized for compartment queries
recorded             TIMESTAMP            -- when the audit event occurred
type_system          STRING
type_code            STRING               -- 'rest' | 'create' | 'read' | ...
subtype_codes        ARRAY<STRUCT<system, code, display>>
action               STRING               -- 'C' | 'R' | 'U' | 'D' | 'E'
outcome              STRING               -- '0' (success) | '4' (minor) | '8' (serious) | '12' (major)
agent                ARRAY<STRUCT<...>>   -- who/what/from-where; see §2.1
source               STRUCT<observer, site, type>
entity               ARRAY<STRUCT<...>>   -- what was accessed; see §2.2
body                 STRUCT<...>          -- full dbignite AuditEvent body
bronze_ingest_id     STRING
governed_at          TIMESTAMP
governance_pipeline  STRING
```

**Partition strategy** (per ADR-0010 §3 partitioning):

`(year_month(recorded), patient_hash_bucket(patient_id))` — heavy partitioning is mandatory at audit volume. Hot partitions ZORDER on `(patient_id, recorded)`.

**Volume estimate** at 10M-member-payer scale:

| Source | Annual rate (worst case) |
|---|---|
| Patient Access REST | 100M (10/member × 10M members) |
| Provider Access REST + bulk | 2.5M (50/provider × 50K providers; bulk amortized) |
| Payer-to-Payer transitions | 1M (10% member turnover × 1M events/year) |
| Prior Auth flow events | 50M (5/member/year) |
| SMART OAuth issuance + refresh | 500M (high; refresh-heavy) |
| Bulk export per-file download | 5M |
| Internal Governance audit events | 200M (10-15/Bronze write × ingest volume) |
| **Total** | **~800M-1B rows/year worst case** |

Storage: ~2-5 TB/year of Delta with adequate compression. Manageable; sized into the operability ADR's cluster sizing.

### 2.1 AuditEvent.agent — who/what initiated

Per FHIR R4 AuditEvent profile + the Patient Access API spec, with explicit SMART scope capture per session-018 Q3 lock:

```
agent ARRAY<STRUCT<
  type             STRUCT<system, code>    -- 'human-user' | 'application' | 'doh' (device-or-human)
  who              STRUCT<reference, identifier, display>  -- Reference(Patient|Practitioner|Device|Organization)
  requestor        BOOLEAN
  role             ARRAY<STRUCT<...>>      -- e.g., 'patient' | 'provider' | 'payer-staff'
  network          STRUCT<address, type>   -- IP address + type (ipv4 | ipv6 | dns | uri)
  policy           ARRAY<STRING>           -- granted SMART scopes (urn:smart:scope:<scope-string>)
  altId            STRING                  -- secondary identifier (e.g., SSO subject)
  detail           ARRAY<STRUCT<type, value>>  -- requested-but-not-granted scopes + OAuth grant type; see below
>>
```

Two agents typically: the human-user (Patient or Practitioner) AND the application (the SMART app's SP). Both participate in the audit chain.

#### 2.1.1 SMART scope capture (Q3 lock)

**Granted scopes** in `agent.policy[]` as `urn:smart:scope:<scope-string>` URIs:

```
agent[0].policy = [
  "urn:smart:scope:patient/Coverage.read",
  "urn:smart:scope:patient/ExplanationOfBenefit.read",
  "urn:smart:scope:patient/Encounter.read",
  "urn:smart:scope:openid",
  "urn:smart:scope:fhirUser"
]
```

**Requested-but-not-granted scopes** in `agent.detail[]` of type `requested-scope`:

```
agent[0].detail = [
  { type: "requested-scope", value: "urn:smart:scope:system/*.write" },  -- requested; denied
  { type: "requested-scope", value: "urn:smart:scope:patient/*.write" }, -- requested; denied
  { type: "grant-type", value: "authorization_code" },                    -- OAuth grant type
]
```

Captures the prompt-engineering / scope-creep signal cheaply (bounded data volume; few hundred extra bytes per AuditEvent) and gives breach investigators full scope context.

**OAuth grant type** in `agent.detail[]` of type `grant-type` — distinguishes patient-launch / EHR-launch / system-context / refresh from each other at-a-glance for compliance review.

Cost: minor (~200-500 bytes per AuditEvent for typical scope sets); benefit: member-facing transparency portals show "this app had read access to your coverage and claims, requested write access which was denied"; breach investigators have the full picture per access event.

**Note on SMART scope grammar:** the canonical scope grammar (resource-level vs instance-level scopes, SMART v2 scopes like `patient/*.rs` vs SMART v1 `patient/*.read`) is **specified in [ADR-0006 §5](0006-smart-on-fhir-and-udap-security.md)**. This ADR captures the audit-side surfacing only; the scope syntax ADR-0006 ratifies is what gets written to `agent.policy[]` and `agent.detail[]`.

### 2.2 AuditEvent.entity — what was accessed

```
entity ARRAY<STRUCT<
  what       STRUCT<reference, identifier, display>  -- Reference(Patient|Coverage|EOB|...)
  type       STRUCT<system, code>           -- '1' (person) | '2' (system object) | '4' (domain resource)
  role       STRUCT<system, code>           -- '1' (patient) | '4' (domain resource) | '6' (data destination)
  lifecycle  STRUCT<system, code>           -- '6' (access) | '9' (de-identification) | ...
  name       STRING
  description STRING
  query      base64Binary                   -- the search params if any
  detail     ARRAY<STRUCT<type, value>>     -- e.g., 'Resource-Count' / '147'
>>
```

For Patient Access reads, the entity is the queried resource(s). For bulk export, entities expand to the file manifest. For Provider Access, entities include both the patient and the queried resource set.

### 3. Patient-facing access transparency

`GET /Patient/{id}/AuditEvent` returns the member's audit log:

- Routed to Gold Layer 4 Patient compartment query (per ADR-0010 §2.4).
- Filterable by `date`, `agent.type`, `outcome`.
- Paged with `_count` (default 50; max 500).
- Returns only `outcome != fail` events by default (members shouldn't see opaque internal errors); `outcome=fail` accessible with explicit query.
- Rate-limited per OAuth subject: **100 req/min** default (per session-018 cluster G1); deployment-configurable via `ronin_patient_transparency_rate_limit`.
- Cached at the TS App middleware with `_count`-aware caching (cache key includes `_count`, `date`, `agent.type`, `outcome` filters).
- Authorized via SMART scopes — `patient/AuditEvent.read` required.

This is a key UX surface for SMART app developers: members see "your data was accessed by Dr. Smith's office at 2:34pm yesterday for treatment purposes" in their patient portal.

### 4. Application access log (separate surface)

HTTP-level log per request, parallel to FHIR AuditEvent. Lives in Gold:

```
ronin_<warehouse>.gold.application_access_log
```

Schema:

```
request_id          STRING NOT NULL    -- UUID v7; correlates with FHIR AuditEvent if generated
timestamp           TIMESTAMP NOT NULL
method              STRING             -- 'GET' | 'POST' | ...
path                STRING
query_string        STRING
status_code         INT
duration_ms         BIGINT
bytes_in            BIGINT
bytes_out           BIGINT
user_agent          STRING
oauth_subject       STRING             -- end-user OAuth subject claim (NULL for unauthenticated)
app_sp_id           STRING             -- the App SP identity
client_ip           STRING
deployment_id       STRING             -- per-deployment correlator
trace_id            STRING             -- distributed tracing handle
ip_anonymized_at    TIMESTAMP          -- when client_ip last-octet-zeroed per privacy policy
```

Partitioned by `(year_month(timestamp), hour(timestamp))`. ZORDER on `(oauth_subject, timestamp)` for per-user query.

**Distinct from AuditEvent because:** application log is HTTP-mechanics (latency, status, bytes); AuditEvent is FHIR-semantics (who accessed what, role, lifecycle). Operators want the former for debugging; auditors want the latter for compliance.

**SIEM export** via scheduled Spark Job writes daily aggregates and detailed records to a customer-supplied S3/ADLS/GCS endpoint in Splunk / Sentinel / Datadog-compatible JSON formats. Customer configures via `ronin_siem_export` deployment variable.

### 5. SMART OAuth event log

Token-issuance audit, parallel surface in Gold:

```
ronin_<warehouse>.gold.oauth_event_log
```

Schema:

```
event_id            STRING NOT NULL
timestamp           TIMESTAMP NOT NULL
event_type          STRING             -- 'token_issued' | 'token_refreshed' | 'token_revoked' |
                                       -- 'auth_failed' | 'consent_granted' | 'consent_revoked'
oauth_subject       STRING
app_client_id       STRING
app_sp_id           STRING
scopes_granted      ARRAY<STRING>
scopes_requested    ARRAY<STRING>
grant_type          STRING             -- 'authorization_code' | 'client_credentials' | 'refresh_token'
token_id            STRING             -- opaque token reference (NOT the token itself)
expires_at          TIMESTAMP
client_ip           STRING
failure_reason      STRING             -- non-NULL on 'auth_failed'
launch_context      STRING             -- 'standalone' | 'ehr-launch' | 'patient-portal' | 'system'
patient_context     STRING             -- patient_id when SMART-launched in patient context
```

Partitioned by `(year_month(timestamp), event_type)`. ZORDER on `(oauth_subject, timestamp)`.

**Failed-auth events** (`event_type='auth_failed'`) feed breach detection. Pattern: ≥N failed attempts within window from same client_ip / oauth_subject triggers a `gold.oauth_breach_signal` row for SIEM and operator review. Thresholds + response actions per §7.

#### 5.1 PHI redaction in failed-auth events (Q6 lock)

**Architectural insight (per ADR-0010 §5 server-managed UUID v7 fhir_ids):** Ronin URL paths are **PHI-clean by default** because fhir_ids are server-minted UUIDs carrying no PHI. This eliminates a HIPAA exposure vector that other FHIR servers create when they accept client-supplied IDs. The server-managed-ID default IS a HIPAA-defense mechanism worth calling out in compliance positioning materials: *"Ronin's UUID v7 fhir_id default removes a HIPAA exposure vector that other FHIR servers create when they accept client-supplied IDs."*

**Residual PHI surfaces in failed-auth events** (which still need redaction):

| Source | Default treatment | `strict_federal` full capture |
|---|---|---|
| Query parameter values matching identifier patterns (SSN, member ID, etc.) | SHA-256 hash with per-deployment salt | Original captured |
| Request body PHI fields in `$member-match` etc. | Field-level redaction to category labels (`<name>`, `<dob>`, `<address>`); structural shape preserved | Full body |
| SMART launch context `patient` parameter | Hashed (still useful for pattern detection) | Original |
| URL path fhir_id (default Ronin) | **No redaction needed** — non-PHI UUID v7 | No redaction needed |
| Client IP / user-agent / app_client_id / grant-type / requested-scopes / failure-reason | Captured fully (not PHI) | Same |

Hash-with-salt enables pattern detection (5 failed attempts targeting hash X) without storing identifiers in the clear. Salt is per-deployment + rotated annually (per `ronin_audit_salt_rotation_schedule` in operability ADR).

**`strict_federal` opt-in for full PHI capture** requires:
- `tamper_evident_chain` integrity mandatory (§10.2).
- Tighter UC RBAC on the `event_type='auth_failed'` partition — only security team role can SELECT; operators get hashed view.
- Customer attests in install script that contract / regulatory authority requires elevated capture.

**Deployment variables:**
```yaml
ronin_failed_auth_phi_capture: redacted   # default | "full" (strict_federal opt-in only)
ronin_allow_client_supplied_ids: false    # default; v2+ may flip; install-script warns at override
```

#### 5.2 Client-supplied fhir_id override (forward-looking, v2+ readiness)

If a future v2+ Ronin allows client-supplied fhir_ids (overriding ADR-0010 §5 server-managed default), the install script presents the administrator with a HIPAA warning at selection:

> **Warning:** Enabling client-supplied fhir_ids may create a HIPAA exposure vector. Client IDs that contain or derive from PHI (e.g., MRN-derived, SSN-derived) will appear in URL paths, audit trails, error logs, and SIEM exports. The recommended posture is server-managed UUID v7 fhir_ids (default), which carry no PHI. Override only if your deployment has documented requirements for client-supplied IDs.

Administrator's accept-or-revert decision is **recorded in `gold.installation_audit`** with timestamp + administrator identity for compliance evidence. Server-managed remains the default; override requires explicit positive action + documented attestation.

This is a v2+ design hook ratified now so the v1 architecture doesn't paint itself into a corner.

#### 5.3 Breach detection patterns (Q7 lock)

Three concrete patterns ship in v1, each with per-deployment-configurable thresholds + response action.

**Detection patterns:**

| Pattern | Default trigger | What it catches |
|---|---|---|
| `brute_force` | 5 failed_auth events from same `(client_ip, oauth_subject)` within 5 minutes | Targeted credential guessing against one account |
| `credential_stuffing` | 20 failed_auth events from same `client_ip` across distinct `oauth_subject`s within 10 minutes | Botnet trying many credentials |
| `scope_escalation` | 3 requested-but-denied scope events from same `(oauth_subject, app_client_id)` within 60 minutes | App probing for privilege escalation |

**Configuration:**

```yaml
ronin_breach_detection:
  brute_force:
    n_attempts: 5
    window_minutes: 5
    grouping: [client_ip, oauth_subject]
    response: alert_only
  credential_stuffing:
    n_attempts: 20
    window_minutes: 10
    grouping: [client_ip]
    response: rate_limit_ip
  scope_escalation:
    n_attempts: 3
    window_minutes: 60
    grouping: [oauth_subject, app_client_id]
    response: alert_only
```

**Response actions** (per-pattern configurable; stackable):

- `alert_only` (default) — log to `gold.oauth_breach_signal` + push to SIEM via export hook (§4).
- `rate_limit_subject` — temporarily restrict OAuth subject's rate limit (default: 10 req/min for 15 minutes).
- `rate_limit_ip` — temporarily IP-level rate limit (default: 10 req/min for 30 minutes).
- `revoke_tokens` — revoke active tokens for affected subject (forces re-auth).

**`strict_federal` tighter defaults:** `brute_force` = 3 attempts in 5 minutes; `credential_stuffing` = 10 attempts in 10 minutes; `revoke_tokens` response on every detection.

**Signal table schema** (`gold.oauth_breach_signal`):

```
signal_id            STRING NOT NULL    -- UUID v7
detected_at          TIMESTAMP NOT NULL
pattern              STRING             -- 'brute_force' | 'credential_stuffing' | 'scope_escalation'
severity             STRING             -- 'low' | 'medium' | 'high'
grouping_key         STRUCT<client_ip, oauth_subject, app_client_id>
event_count          INT                -- attempts in the window
window_start         TIMESTAMP
window_end           TIMESTAMP
response_taken       ARRAY<STRING>      -- which actions fired
resolved_at          TIMESTAMP          -- non-NULL after manual review or auto-resolve
reviewer_id          STRING
reviewer_note        STRING
```

**Implementation:** Spark Structured Streaming job consumes `gold.oauth_event_log` CDC; aggregates per pattern's grouping + window; emits to `gold.oauth_breach_signal` when thresholds breach; triggers configured response actions via the TS App's rate-limit middleware (per ADR-0013) or OAuth token revocation endpoint.

**Deferred to operability ADR:** SIEM-integration templates (Splunk / Sentinel / Datadog payload shapes), on-call paging integration (PagerDuty / Opsgenie webhook), auto-resolve heuristics, tunable false-positive suppression (legitimate user-app refresh cycles).

### 6. Governance audit (Bronze→Silver→Gold transformations)

Per ADR-0010 Amendment 3, Silver rows carry an `audit_trail` STRUCT documenting transformations between tiers:

```
audit_trail ARRAY<STRUCT<
  phase       STRING       -- 'field_check' | 'assembled_check' | 'dq' | 'dar_fill' | 'mpi' | 'reference_resolution' | 'hl7_validator'
  timestamp   TIMESTAMP
  actor       STRING       -- 'system' | 'transpiler_v<x>' | 'operator:<id>'
  decision    STRING       -- 'pass' | 'warn' | 'reject' | 'merge' | 'dar_fill_applied' | ...
  details     STRING       -- JSON-encoded per-phase outcome
>>
```

This is **per-row audit at the transformation level** — distinct from AuditEvent which is per-API-request. Queryable in Spark SQL for operator investigations of "why did this row promote / reject / get DAR-filled?"

### 7. Bulk export audit

Every `$export` call has its own audit trail:

- **Kickoff event** — AuditEvent with `type=execute, subtype=export` capturing requester, time, Group, filters.
- **Per-file generation event** — one event per output NDJSON file generated, capturing file path, record count, sha256. **Carries `entity.detail['Resource-Count-By-Type']` map** with per-type counts (Observation: 2.3M, Coverage: 5K, etc.) — no per-resource enumeration even at 10s-of-millions-of-resources scale (Q4 lock).
- **Per-file download event** — AuditEvent on each NDJSON file download (TS App middleware logs the download).
- **Completion event** — AuditEvent capturing total records, file count, completion time.
- **Revocation event** — if the export is revoked or expires, AuditEvent records the lifecycle change.

For Payer-to-Payer transitions, the bulk export audit trail is a higher-stakes compliance artifact — it documents which member data was shared with whom, when, and under what consent attestation (per Da Vinci HRex member-match attestation).

**`$everything` Bundle response handling** (Q4 lock): a `$everything` call returning a Bundle with 1000+ entries does NOT enumerate every resource in `entity[]` — would bloat the AuditEvent itself. Default: enumerate the first 100 entities; aggregate the rest as `entity[N+1].detail['Resource-Count-By-Type']` summary. Configurable threshold via `ronin_audit_entity_enumeration_limit` deployment variable; default 100.

### 8. Cross-org QHIN audit hooks (TEFCA / CommonWell / Carequality)

For Ronin deployments participating in QHIN exchanges (per ADR-0012 §6 PPRL + cross-org matching):

- **Per-QHIN AuditEvent export** runs on a per-QHIN-policy schedule (TEFCA QHIN Common Agreement specifies minimums; CommonWell + Carequality similar).
- **Cross-QHIN identifiers** in `agent.altId` carry the QHIN-specific subject identifier when the query crosses QHIN boundaries.
- **Consent attestation** carried via `agent.policy` from the originating QHIN's consent record.
- **Breach notification flow** per QHIN policy; Ronin generates the audit material; QHIN-side aggregator handles the notification.

Configured per deployment via `ronin_qhin_audit_export` — destination + cadence + format per QHIN.

#### 8.1 Cross-QHIN consent enforcement (Q5 lock)

When a query enters Ronin through a QHIN partner from a different QHIN's participant, the requesting party carries a purpose-of-use code (treatment / payment / operations / research / public-health / etc.) and a consent attestation. Three-preset deployment policy controls how Ronin enforces consent at the cross-QHIN boundary:

```yaml
ronin_cross_qhin_consent_policy:
  trust_qhin_for_treatment             # default — trust QHIN attestation for treatment; check Consent resource for others
  always_check_consent_resource         # check FHIR Consent regardless of purpose-of-use, even for treatment
  consent_required_for_all_purposes     # strict — default for strict_federal; explicit Consent required for every cross-QHIN request
```

**Default `trust_qhin_for_treatment`** matches TEFCA framework's default-allowed purpose. For `research`, `public-health`, `marketing`, cross-org `payment`, and cross-org `operations`, Ronin checks the patient's FHIR `Consent` resource and denies if consent isn't granted for that purpose.

**Audit-side capture per cross-QHIN AuditEvent:**

| Field | Value |
|---|---|
| `agent.policy[]` | QHIN consent attestation URI (`urn:tefca:consent-attestation:treatment-default` or per-QHIN-specific) |
| `agent.altId` | Cross-QHIN subject identifier (provider's QHIN-issued identity) |
| `entity.detail['purpose-of-use']` | Requesting purpose code (`treatment` / `research` / `public-health` / etc.) |
| `entity.detail['consent-decision']` | Ronin's Consent check outcome (`allowed` / `denied`); NULL when trust-QHIN-only path skipped Consent check |
| `entity.detail['originating-qhin']` | QHIN identifier where the request originated |

**Deferred to future ADRs:**

- **QHIN onboarding flow, per-QHIN trust framework specifics, QHIN-specific consent-attestation grammar, QHIN-level audit export schedules** — TEFCA Common Agreement implementation details that depend on framework evolution. Belongs in a future TEFCA participation ADR (queued).
- **Consent enforcement *logic* (which Consent resources govern which purpose-of-use codes; how cross-resource Consent rules compose)** — SMART scope + business-logic concern owned by [ADR-0018 §5](0018-patient-portal-consent-and-read-time-filter.md) (read-time filter gate) and [ADR-0015 Amendment 2](0015-validation-architecture.md) (SLS labels that the gate evaluates). Cross-QHIN consent precedence remains queued in the TEFCA participation ADR.

This ADR locks the audit-side capture only.

### 9. Retention — mandate-anchored profiles + hot/warm/cold tiering

Retention is **mandate-anchored**, not arbitrary. Four shipped `ronin_audit_retention_profile` presets matching the actual federal + state regulatory landscape:

| Profile | Total | Hot months | Warm months | Cold months | Mandate basis |
|---|---:|---:|---:|---:|---|
| **`hipaa_baseline`** *(default for `payer_baseline` + `provider_baseline`)* | 6y | 24 | 48 | 0 | HIPAA Security Rule § 164.316(b)(2): 6 years for documentation of policies, procedures, and activities |
| **`medicare_advantage`** *(when MA is a covered LOB)* | 10y | 24 | 96 | 0 | CMS MA program: 10-year retention for patient records |
| **`state_extended`** *(CA, IN, PA, NY, others)* | 7y | 24 | 60 | 0 | State law variations (typically 7y) |
| **`strict_federal`** *(federal contracts, NIST 800-53 high baseline)* | 15y | 24 | 96 | 60 | Federal contract typical (CMS RAC 3y + extended) |

Free-form override `ronin_audit_retention_years: <N>` permitted for edge cases (specific federal contracts requiring 20+ years).

**CMS-0057-F adds no audit-specific retention** — the rule defers to existing federal + state law. **CMS RAC lookback is 3 years from claim payment** — billing-fraud recoupment scope; not an audit-log retention mandate.

**CMS-0057-F Patient Access data-availability floor (clarified 2026-06-21):** for CMS-0057-impacted payers, the Patient Access API must return data with a date of service on or after **2016-01-01 for all current enrollees** (per [Coverage research §6](../research/2026-06-21-coverage-deep-research.md#6-cms-0057-f-retention--what-the-rule-actually-says-about-coverage-data)). This is the data the API must *make available* — distinct from the audit-log retention profiles above. The profiles set the audit retention ceiling; the 2016-01-01 floor sets the underlying-data-return floor. Both apply concurrently. By default, `payer_baseline` profile pack inherits both: the `hipaa_baseline` audit retention (6 years) AND the 2016-01-01 data-availability floor for Coverage / ExplanationOfBenefit / USCDI clinical data on current enrollees. `medicare_advantage` pack stacks the 10-year audit retention on top of the same 2016-01-01 floor.

#### 9.1 Tier semantics

**Hot tier (months 0-24):** Gold AuditEvent tables with full ZORDER + OPTIMIZE; full FHIR API queryability; patient transparency endpoint returns real-time results; SIEM streaming export real-time.

**Warm tier (months 24-72 typical):** same Gold AuditEvent tables; OPTIMIZE less aggressive; ZORDER skip-index helps but queries pay 5-10× hot-tier latency. Still FHIR-queryable; UX may add "this query covers older data and may take longer" hint after ~1s. No special API handling.

**Cold archive tier (months 72+ for `strict_federal`):** moved by scheduled Databricks Job (default monthly) to customer-controlled archive storage. **Customer finops policy drives storage class selection** — Ronin doesn't dictate.

```yaml
ronin_audit_cold_archive:
  bucket: s3://customer-audit-archive/ronin/    # or azure / gcs equivalent
  storage_class: glacier_instant_retrieval       # customer chooses per finops policy
  format: parquet                                 # parquet | ndjson
  recall_sla_hours: 4                             # documented expectation
```

Storage-class options span cloud-provider tiers: S3 Glacier Instant Retrieval / Glacier Flexible / Glacier Deep Archive; Azure Cool Blob / Archive Blob; GCS Coldline / Archive. Customer's finops governance flows through.

#### 9.2 Cold-tier API behavior — 202 async recall

Queries that touch cold-tier data return `202 Accepted` with async recall:

```
GET /Patient/{id}/AuditEvent?_lastUpdated=ge2018-01-01

Hot+warm coverage only → 200 OK with Bundle
Touches cold tier      → 202 Accepted
                         Content-Location: /_async/audit-recall/{job-id}
                         Retry-After: 3600
```

Operator queries against cold use the same async pattern. Bulk export `$export` over the full retention window orchestrates cold-tier rehydration with a longer-than-default completion window (24-48h vs typical hours).

**No real-time requirement for cold data** — confirmed against industry guidance (immediate recall 60-90 days; hot searchable 12-24 months; cold archive for compliance lookup up to 6+ years). Patient transparency members essentially never query > 12 months back; compliance and breach investigations accept hour-scale async recall.

#### 9.3 Cost disclosure at install

`scripts/ronin-install.sh` (per ADR-0013 §7) shows projected storage cost at the selected retention profile before commit. Customers acknowledge before commit; `strict_federal` requires explicit retention-mandate documentation pointer.

#### 9.4 Patient-controlled deletion

AuditEvent records are immutable evidence; patient-data-deletion requests (per state laws / GDPR-equivalent) do NOT delete AuditEvent records — they delete the underlying PHI but retain the audit trail (with the patient `who.reference` redacted to opaque pseudonym). Belongs in a future hard-delete ADR (ADR-0010 §8 "Hard-delete / GDPR right-to-be-forgotten" queued).

### 10. Audit integrity model

Ronin ships two integrity models; the **Delta-native** posture is sufficient for HIPAA Security Rule § 164.312(c)(1) "Integrity" without per-row hash overhead. The tamper-evident hash chain stays opt-in for environments with explicit cryptographic-chain mandates (NIST 800-53 high baseline, certain federal contracts, some state security frameworks).

#### 10.1 Delta-native tamper-evidence (default for `hipaa_baseline` / `medicare_advantage` / `state_extended`)

**Five mechanisms layered for defensible HIPAA compliance posture:**

1. **Unity Catalog RBAC** — INSERT-only grant to the Governance pipeline SP. NO UPDATE / DELETE grants to anyone on the audit tables. Any privilege elevation is itself audited at the UC metastore level (separate audit trail). HIPAA "access controls" § 164.312(a) satisfied.

2. **Append-only convention enforced at the bundle level** — the canonical write path uses `INSERT INTO` exclusively; no `UPDATE` or `DELETE` statements ship in the Governance pipeline source code. **Bundle-build-time lint catches violations**; UC Function templates that ship with the bundle reject UPDATE/DELETE on audit tables. The append-only property is code-enforced, not just convention.

3. **Delta transaction log** (`_delta_log/`) — records every commit with timestamp, writing principal (App SP identity), operation type, record count, version number. Immutable by design; lives in cloud storage with object versioning (S3 Versioning / Azure Blob Versioning / GCS Object Versioning). **Tampering the transaction log itself leaves traces in cloud-storage version history.** Customer can verify integrity by inspecting the transaction log + comparing against object versions.

4. **Time-travel for forensic restoration** — `delta.logRetentionDuration` tuned per retention profile:

   | Profile | Hot tier `logRetentionDuration` | Warm tier `logRetentionDuration` | Cold tier |
   |---|---|---|---|
   | `hipaa_baseline` | **24 months** | 12 months | n/a |
   | `medicare_advantage` | **24 months** | 12 months | n/a |
   | `state_extended` | **24 months** | 12 months | n/a |
   | `strict_federal` | **24 months** | 24 months | not applicable (rows are immutable archives) |

   The 24-month hot-tier time-travel window covers the full forensic-restoration use case (operators can recover known-good state across an incident-response window without needing the hash chain).

5. **Delta history queryable** for forensic investigations — `DESCRIBE HISTORY gold.audit_event_r4` shows every commit; unexpected commits (a non-Governance SP writing) are evident. Combined with mechanism 3, gives a full audit trail of the audit trail.

**Customer-facing compliance posture** (provide to HIPAA auditors verbatim):

> "Audit log integrity is enforced via Unity Catalog access controls (INSERT-only writes by a single service principal), append-only write conventions enforced at the bundle source-code level with build-time linting, and the Delta transaction log which provides cryptographically-verifiable commit history backed by cloud-storage object versioning. Time-travel queries enable forensic restoration over a 24-month rolling window. This implements HIPAA Security Rule § 164.312(c)(1) Integrity 'reasonable safeguards' through policies and procedures preventing improper alteration or destruction."

This is defensible compliance posture without per-row hash overhead. Provided to customers as a one-pager for their compliance officers; ships with ADR-0013 install documentation.

#### 10.2 Tamper-evident SHA-256 hash chain (opt-in for `strict_federal`)

For environments where contract / state security framework explicitly requires NIST 800-53 high-baseline tamper-evidence or independent verification beyond Delta-native mechanisms. Required scope examples:

- Federal contracts with explicit FIPS-202 / NIST 800-53 audit integrity controls.
- California OCR / NY DOH-elevated security frameworks where flow-down demands cryptographic chain.
- Healthcare data brokerages with downstream-compliance flow-down to federal-payer programs.

**Chain mechanics:**

Each AuditEvent row carries:
- `prev_hash STRING` — SHA-256 hash of the previous row's canonical-serialization.
- `row_hash STRING` — SHA-256 hash of this row's canonical serialization including `prev_hash`.

Chain verification: a daily Databricks Job runs `SELECT * FROM audit_event_r4 ORDER BY recorded` and verifies each row's `prev_hash` matches the prior row's `row_hash`. Breakage triggers a `gold.audit_integrity_signal` row + operator alert + (optional) automated incident response.

Performance: hash computation adds ~1ms per AuditEvent write; chain verification is a scheduled offline scan (no runtime impact). Enables federal-payer-grade compliance audits without forking the audit substrate.

#### 10.3 Selection variable

```yaml
ronin_audit_integrity:
  delta_native             # default for hipaa_baseline / medicare_advantage / state_extended
  tamper_evident_chain     # default for strict_federal; opt-in for any profile
```

`strict_federal` profile (per ADR-0014 §4) defaults to `tamper_evident_chain`. All other profiles default to `delta_native` with the explicit five-mechanism story documented.

### 11. Performance posture — async write; audit must not slow the synchronous path

The synchronous API request path (`PUT /Patient/...`, `GET /Patient/.../$everything`, etc.) returns 200/201 before AuditEvent generation is complete. Audit is generated asynchronously via a per-request audit-emit queue read by a Spark Streaming job that writes to Bronze AuditEvent tables.

**Concrete flow:**

1. TS App handler completes request; returns response to client.
2. Handler emits audit-event message to a per-deployment Spark Structured Streaming source (Databricks Lakeflow Events preferred; Kinesis / Event Hubs / Pub/Sub per cloud).
3. Streaming consumer writes Bronze `audit_event_r4` rows.
4. Bronze → Silver → Gold AuditEvent pipeline runs per the standard Amendment 3 flow (without DQ rules or DAR fill — AuditEvent is canonical-by-construction).
5. Patient transparency reads (per §3) hit Gold.

**Backpressure**: if the audit-emit queue accumulates, requests still complete; queue depth is observable; deployments can scale the streaming consumer. The synchronous API path is never gated on audit completion.

**Performance budget:** audit-emit overhead < 5ms p95 at the request handler.

#### 11.1 Async durability — at-least-once + sync_confirm strict mode (Q8 lock)

**Two durability postures by deployment profile:**

| Mode | Profile default | Latency overhead | Worst-case data-loss window |
|---|---|---|---|
| `at_least_once_async` | `hipaa_baseline` / `medicare_advantage` / `state_extended` | <1ms | ~1ms between TS App produce-and-bus-ack |
| `sync_confirm` | `strict_federal` | ~5-10ms | Effectively zero |

**`at_least_once_async` (default):**
- TS App produces with `acks=all` (Kinesis equivalent: PutRecord synchronous acknowledgment; Pub/Sub: confirmed publish; Lakeflow Events: at-least-once delivery semantics).
- Bus replicates across brokers (3-replica typical) — data-loss requires multi-broker simultaneous failure in <1ms window.
- Returns response to client immediately after produce-acknowledged.

**`sync_confirm` (strict_federal):**
- TS App waits for full bus commit acknowledgment before sending 200/201 to client.
- Eliminates the produce-to-ack durability window entirely.
- ~5-10ms additional latency per request acknowledged as the trade-off for guaranteed audit capture in federal-contract environments.
- Install script attests customer contract / regulatory authority requires this.

**Per-cloud event-bus selection (`ronin_audit_event_bus`):**

| Cloud | Default | Alternative |
|---|---|---|
| Databricks-on-AWS | `kinesis` | `kafka_msk` / `databricks_lakeflow_events` (when GA) |
| Databricks-on-Azure | `event_hubs` | `databricks_lakeflow_events` (when GA) |
| Databricks-on-GCP | `pubsub` | `databricks_lakeflow_events` (when GA) |

Databricks Lakeflow Events becomes default across clouds once GA across the customer's cloud — preferred for Databricks-Partner consistency per ADR-0009.

**Consumer crash recovery — at-least-once delivery + idempotency dedup at Bronze:**

- `request_id` (UUID v7 generated at TS App emit time) is the dedup key.
- Bronze write uses `MERGE INTO bronze.audit_event_r4 USING ... ON request_id = ?` — duplicate emit after consumer-crash replay produces no duplicate AuditEvent.
- Spark Streaming checkpoints to a UC Volume (`ronin_audit_consumer_checkpoint_volume`); crash recovery replays from last checkpoint; dedup handles the in-flight replay window.
- `request_id` dedup keys retained for 24 hours (configurable via `ronin_audit_duplicate_dedup_window_hours`).

**Observable backpressure:**
- Consumer lag exposed as Databricks observability metric; pushed to customer SIEM via §4 export hook.
- Operator alert at `lag > 5 min` (configurable via `ronin_audit_consumer_lag_alert_minutes`).

**TS App in-flight loss mitigation:** if the TS App process crashes between request completion and bus produce, that single in-flight event is lost. Bounded to one App instance's in-flight queue at the moment of crash (typically <100 events at peak under `at_least_once_async`). **Mitigated by Databricks Apps multi-instance HA (per ADR-0013 §2 zero-downtime deployments + session affinity).** Documented in compliance materials for `hipaa_baseline`; `sync_confirm` eliminates this surface too.

**Configuration:**

```yaml
ronin_audit_emit_durability:
  mode: at_least_once_async              # default | "sync_confirm" (strict_federal)
  event_bus: databricks_lakeflow_events   # | kinesis | event_hubs | pubsub | kafka_self_managed
  consumer_checkpoint_volume: /Volumes/<catalog>/system/audit_consumer_checkpoint
  consumer_lag_alert_minutes: 5
  duplicate_dedup_window_hours: 24
```

### 12. AuditEvent generation surface — where each event originates

| Trigger | Generated by | Latency budget |
|---|---|---|
| FHIR REST read (GET) | TS App middleware (post-handler) | Async; <5ms emit |
| FHIR REST write (POST/PUT/DELETE/PATCH) | TS App middleware (post-handler) | Async; <5ms emit |
| Bulk export `$export` kickoff | TS App middleware | Sync inside the kickoff response |
| Bulk export NDJSON download | TS App middleware (per-file) | Async per-file |
| SMART OAuth token issuance / refresh / revocation | TS App auth middleware | Sync inside auth response |
| Bronze→Silver Governance transformation | Spark Governance pipeline | Inline (`audit_trail` STRUCT) |
| MPI merge / unmerge / Conditional decision | Spark Governance pipeline | Inline + emits AuditEvent + Provenance per ADR-0012 §8 |
| MPI manual review decision | TS REST stewardship API | Sync |
| Terminology lookup (`$validate-code` etc.) | TS App middleware | **Deployment-configurable** — high-volume; on/off per `ronin_audit_terminology_lookups` (default: off; on for `strict_federal`) |
| Validation decision (DQ rule fire, DAR fill) | Spark Governance pipeline | Inline (`validation_state.dar_fills` per ADR-0015 §6) |

Audit-generation rate ≈ API request rate. AuditEvent tables are one of the highest-write surfaces in Ronin (per §2 volume estimates).

## Consequences

- **Five distinct audit surfaces** instead of one — each serves a distinct purpose. Operators have clearer visibility; auditors get spec-canonical material; SIEMs ingest detailed access logs; patient transparency reads Gold AuditEvent. The decomposition is honest about what audit is used for in production.
- **Ronin's Delta-backed audit IS the federated-store resolution.** Azure FHIR Service customers who federated to scale audit can consolidate onto Ronin. Concrete competitive talking point for ADR-0013 Marketplace positioning. Belongs in customer-facing positioning materials.
- **Audit volume is real.** ~800M-1B rows/year at 10M-member-payer scale. Drives operability ADR cluster sizing. OPTIMIZE/VACUUM schedule + ZORDER tuning matter.
- **Patient transparency rate-limiting is mandatory.** Without rate-limits, a malicious member token could DoS the AuditEvent table. 100 req/min/subject is the default; configurable per deployment.
- **Tamper-evident hash chain is opt-in for `strict_federal`.** Federal-payer-grade compliance gets the chain; commercial payer deployments use append-only + UC RBAC. The substrate supports both without forking.
- **Audit is async on the synchronous path.** Request handlers don't wait for audit emit. Backpressure handled at the streaming consumer. Performance budget is hard: <5ms emit overhead.
- **Customer-supplied SIEM endpoint** integrates Ronin audit into the customer's existing security stack. No Ronin-hosted SIEM; standard exports.
- **Cross-org QHIN audit hooks** are per-deployment configuration. Ronin generates the substrate; QHIN-policy-specific export shapes load at deployment time.
- **AuditEvent records survive PHI deletion** (with patient reference redacted). Future hard-delete ADR addresses the redaction mechanics.

## Alternatives considered

- **One audit table for everything.** Rejected — FHIR AuditEvent + HTTP application log + OAuth events + Provenance + Governance audit serve distinct purposes and have distinct schemas. Forcing them into one table loses queryability and breaks FHIR-spec conformance for AuditEvent.
- **Audit on the synchronous path (sync writes).** Rejected — adds latency to every API request; audit is high-volume; sync writes would dominate request latency. Async is the right tradeoff with observable backpressure.
- **AuditEvent in a separate Postgres or RDBMS.** Rejected — reintroduces the federated-store problem this ADR explicitly resolves. Delta is the right substrate.
- **Patient transparency endpoint on its own UI service.** Rejected — `Patient/{id}/AuditEvent` is the FHIR-spec-canonical query; member apps already speak FHIR. No separate UI service in Ronin scope.
- **No rate limiting on patient transparency.** Rejected — DoS risk is real; 100 req/min default is the cluster G1 lock.
- **Tamper-evident chain by default.** Rejected — chain overhead (~1ms per write + scheduled verification) is unnecessary for commercial payer deployments; opt-in via `strict_federal` is the right tradeoff.
- **Application access log as a flat file** instead of Delta. Rejected — loses UC governance; loses queryability; loses time-travel. Delta with adequate partitioning + ZORDER handles the write volume.
- **No SIEM export hooks.** Rejected — customers operate existing security stacks; lack of SIEM hooks is an adoption blocker.

## Follow-up ADRs queued

- **[ADR-0017: Terminology Service](0017-terminology-service.md)** — Accepted 2026-06-20.
- **Operability slate** — closed in session 019 via three ADRs:
  - **[ADR-0019 §2](0019-storage-and-pipeline-operations.md)** — audit table OPTIMIZE/VACUUM scheduling.
  - **[ADR-0021 §3 + §4 + §5](0021-install-audit-and-runbooks.md)** — streaming consumer materialization, SIEM export templates, breach-signal alerting topology.
- **Hard-delete / GDPR right-to-be-forgotten ADR** — AuditEvent record redaction mechanics when patient data is deleted; per ADR-0010 §8 queue.
- **TEFCA-specific audit export ADR** — per-QHIN audit export shapes and schedules when Ronin formally onboards a QHIN integration.
- **Customer-supplied DQ rule signing** (per ADR-0015 OQ #3) — interacts with audit integrity model if customer rules can mutate audit-relevant data.

## Open questions not closed by this ADR

1. ~~Audit retention beyond 6 years~~ → **Locked (Q1):** mandate-anchored — four profiles (`hipaa_baseline` 6y, `medicare_advantage` 10y, `state_extended` 7y, `strict_federal` 15y); hot/warm/cold split per §9; cold-tier storage class is customer-finops-driven; 202 async recall pattern for cold data; install-script cost disclosure. Free-form `ronin_audit_retention_years` permitted for edge cases.
2. ~~Time-travel-as-tampering-defense vs explicit chain~~ → **Locked (Q2):** Delta-native posture (UC RBAC INSERT-only + append-only bundle-lint + transaction log + 24-month time-travel + cloud-storage object versioning) is sufficient for HIPAA Security Rule § 164.312(c)(1); customer-facing one-pager documents the five-mechanism story for compliance officers. Hash chain opt-in via `tamper_evident_chain` (default for `strict_federal`). Per §10.
3. ~~OAuth scope details in AuditEvent.policy~~ → **Locked (Q3):** granted scopes captured in `agent.policy[]` as `urn:smart:scope:<scope>` URIs; requested-but-not-granted scopes + OAuth grant type captured in `agent.detail[]`. Per §2.1.1. SMART scope grammar specifics ratified in [ADR-0006 §5](0006-smart-on-fhir-and-udap-security.md).
4. ~~Per-resource-type audit verbosity~~ → **Locked (Q4):** no sampling; AuditEvent aggregation already happens at the right granularity (one per HTTP request; one per `$export` job + per-file; one per `$everything` call with Bundle summary). Large-Bundle responses cap enumerated entities at 100 with `Resource-Count-By-Type` summary for the rest. Per §7.
5. ~~Cross-QHIN consent enforcement~~ → **Locked (Q5):** three-preset `ronin_cross_qhin_consent_policy` (default `trust_qhin_for_treatment`); audit-side capture via `agent.policy[]` + `agent.altId` + `entity.detail[purpose-of-use,consent-decision,originating-qhin]`. Consent enforcement logic owned by [ADR-0018 §5](0018-patient-portal-consent-and-read-time-filter.md); cross-QHIN precedence remains in the queued TEFCA participation ADR. Per §8.1.
6. ~~Pre-redaction PHI in failed-auth events~~ → **Locked (Q6):** Ronin URL paths are PHI-clean by default (per ADR-0010 §5 server-managed UUID v7 — surfaced as HIPAA compliance differentiator). Residual PHI surfaces (query params, request body, SMART launch context) hash-with-salt by default; `strict_federal` opt-in for full capture under tighter controls. Forward-looking v2+ install-script warning + `gold.installation_audit` override recording designed in. Per §5.1, §5.2.
7. ~~Failed-auth pattern detection thresholds~~ → **Locked (Q7):** three patterns (brute_force / credential_stuffing / scope_escalation) with default thresholds; four configurable response actions (alert_only / rate_limit_subject / rate_limit_ip / revoke_tokens); `strict_federal` tighter defaults; `gold.oauth_breach_signal` schema; Spark Structured Streaming implementation. Per §5.3. SIEM templates + paging integration + auto-resolve ratified in [ADR-0021 §4 + §5](0021-install-audit-and-runbooks.md).
8. ~~Async write durability~~ → **Locked (Q8):** `at_least_once_async` default (worst-case ~1ms data-loss window via multi-broker failure); `sync_confirm` for `strict_federal` (eliminates window at ~5-10ms latency cost); per-cloud event-bus selection (Databricks Lakeflow Events preferred when GA; Kinesis / Event Hubs / Pub/Sub cloud-specific); Spark Streaming checkpointing + `request_id` idempotency dedup at Bronze MERGE handles consumer crash; TS App in-flight loss mitigated via Databricks Apps multi-instance HA per ADR-0013 §2. Per §11.1.

## Sources

- [FHIR R4 AuditEvent](http://hl7.org/fhir/auditevent.html) — resource spec
- [FHIR Bulk Data Access — Export](https://hl7.org/fhir/uv/bulkdata/) — `$export` audit semantics
- [SMART App Launch 2.0.0 — Audit](http://hl7.org/fhir/smart-app-launch/) — OAuth event audit guidance
- [TEFCA QHIN Common Agreement](https://rce.sequoiaproject.org/) — cross-org audit minimums
- [HIPAA Security Rule audit requirements](https://www.hhs.gov/hipaa/for-professionals/security/index.html) — retention guidance
- [Azure Health Data Services AuditEvent limits](https://learn.microsoft.com/en-us/azure/healthcare-apis/fhir/) — federated-store problem documentation source
- [CMS-2027 compliance landscape note §4](../research/2026-06-19-cms-2027-compliance-landscape.md) — substantive design source
- [Foundations note §5](../research/2026-06-19-fhir-server-foundations.md) — audit substrate context
- ADR-0010 Amendment 3 — Silver tier hosts `audit_trail` STRUCT
- ADR-0011 Amendment 3 — Bronze→Silver→Gold flow for AuditEvent resource
- ADR-0012 §8 — Provenance generation (parallel surface)
- ADR-0013 — federated-store competitive positioning (carries into Marketplace listing)
- ADR-0015 §6 — DAR fill audit trail (parallel embedded audit)
- Chad's session-018 cluster F: "Databricks and Ronin are a solution to the issue of multiple, federated stores."
