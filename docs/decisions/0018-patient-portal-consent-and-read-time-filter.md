# ADR-0018: Patient Portal + Consent + Read-Time Filter — Separate Ronin App, FHIR Consent Storage, Multi-Level Security Gate, HCS Label-Aware Enforcement

- Status: **Accepted**
- Date: 2026-06-20
- Decider(s): Chad
- Session: 019
- Related: [ADR-0006](0006-smart-on-fhir-and-udap-security.md) §5 point 5 (consent gate cross-reference), [ADR-0010](0010-storage-shape.md) (compartment + medallion), [ADR-0011](0011-write-contract.md), [ADR-0012](0012-master-patient-index.md) (HRex `$member-match`), [ADR-0013](0013-deployment-posture.md) (Apps), [ADR-0014](0014-conformance-targets-and-ig-matrix.md), [ADR-0015](0015-validation-architecture.md) Amendment 2 (SLS — provides `meta.security`), [ADR-0016](0016-audit-and-access-transparency.md) §2.1.1 + §8.1, [ADR-0017](0017-terminology-service.md)

## Context

CMS-0057-F locks dual consent obligations: **Provider Access** is opt-OUT (default in; patient can opt out by 01/01/2027) and **Payer-to-Payer** is opt-IN (patient must explicitly consent before each transfer by 01/01/2027). Da Vinci HRex defines a member-match consent profile for `$member-match` operations. These are payer-customer load-bearing requirements; they cannot ship as v1.x fast-follow.

Above the regulatory floor, FHIR Consent + the HL7 Healthcare Privacy and Security Classification System (HCS, operationalized via the DS4P IG) define a far more capable consent surface: multi-level security via the v3-Confidentiality total-order hierarchy, sensitivity categories for 42 CFR Part 2 / behavioral health / reproductive health / HIV / minor-patient data, and provision-based granular permit/deny rules. ADR-0015 Amendment 2's SLS materializes `meta.security` on every coded resource; this ADR uses those labels to make Consent provisions actually enforceable.

Three architectural moves close the loop:

1. **A patient portal as a separate Ronin App.** The portal is a SMART client to Ronin's FHIR API; it discovers Ronin's capabilities at runtime and renders consent UIs accordingly. Portal pushes Consent resources to Ronin via authenticated FHIR REST; Ronin enforces them.
2. **Consent storage as standard FHIR Consent resources.** They live in the medallion per ADR-0010, with the same lifecycle, versioning, audit, and Patient compartment indexing as any other clinical resource.
3. **Read-time filter that joins three signals.** Requester clearance (computed from SMART scope + IdP + purpose-of-use), multi-level security (`meta.security` confidentiality vs. clearance ceiling), and Consent provision matching (`meta.security` sensitivity tags vs. `Consent.provision.securityLabel`). Excluded resources never reach the response; AuditEvent records the exclusion for the auditor's view.

## Decision

### 1. Consent storage — standard FHIR Consent in the medallion

Consents land in `gold.consent_r4_current` per ADR-0010's storage shape, with the same Bronze→Silver→Gold flow, version history, Patient compartment indexing, and AuditEvent capture as any other resource. The FHIR R4 Consent resource is the canonical shape — no Ronin extensions in v1.

```
ronin_<warehouse>.bronze.consent_r4
ronin_<warehouse>.silver.consent_r4
ronin_<warehouse>.gold.consent_r4
ronin_<warehouse>.gold.consent_r4_current   -- Layer 3 current-version projection per ADR-0010 §4
```

Consents are first-class FHIR resources: SMART scopes apply (`patient/Consent.cruds`, `user/Consent.rs`, `system/Consent.rs`); Patient compartment query filters apply; `_history` returns prior versions; AuditEvent records every read and write.

**Index for read-time filter performance:** the Layer 3 current-version projection adds three denormalized columns to support efficient lookup during the §5 enforcement gate:

- `purpose_codes` ARRAY<STRING> — distinct codes from `provision.purpose[]` across all nested provisions.
- `actor_references` ARRAY<STRING> — distinct `Organization`/`Practitioner`/`PractitionerRole` references from `provision.actor.reference`.
- `applies_to_security_labels` ARRAY<STRING> — distinct codes from `provision.securityLabel[]` across all provisions.

These are auto-generated from the resource body during Silver→Gold promotion; the canonical Consent body is unchanged.

### 2. Three capture surfaces — one storage shape

Consents arrive at Ronin through three paths, all writing through the same `/Consent` FHIR REST surface:

| Surface | Use case | Auth posture |
|---|---|---|
| **Ronin patient portal** (this ADR §3) | Default surface for explicit patient-facing capture; covers most CMS-0057 flows | Patient-context SMART scopes; portal is a registered SMART client |
| **Customer-existing portal** | Larger payers with an existing member portal post Consent resources directly | Customer's IdP-issued tokens with `patient/Consent.cu` scope |
| **Back-office / operator capture** | Call-center or paper-form consent; payer staff records on patient's behalf | User-context SMART scopes; `Consent.performer` = staff user; channel + reason in `Consent.note[]` |

All three paths land Consents in the same store with the same enforcement path. Customers picking the headless contract (§9) can disable the Ronin portal App without losing capture capability.

### 3. Patient portal as a separate Ronin App

The patient portal ships as its own Databricks App in the bundle, alongside the FHIR REST server App from ADR-0013. Same DAB; two App definitions; two SP-grant bundles.

#### 3.1 Discovery contract

At startup and per-session, the portal reads from Ronin's FHIR server:

- `/metadata` — CapabilityStatement (resources supported, profiles asserted, search parameters).
- `/.well-known/smart-configuration` — SMART discovery (scopes, endpoints, capabilities).
- `/.well-known/udap` — UDAP discovery (when `udap_mode != off` per ADR-0006 §3).
- `/metadata?mode=terminology` — TerminologyCapabilities (per ADR-0017 §1).
- `/Consent?patient={patient_id}` — active Consents for the authenticated patient.
- Registered SMART clients via the `/admin/clients` introspection endpoint (drives the "apps connected to your account" view).
- Customer-supplied content bundle for CMS-required educational materials (per §10).

The portal renders consent flows driven by what's actually supported, not hardcoded assumptions. A `provider_baseline` deployment (no CARIN BB) doesn't show CARIN-specific consent UIs because CARIN doesn't appear in the CapabilityStatement.

#### 3.2 SMART client registration

The Ronin portal registers itself as a SMART client at bundle deploy time (via the DAB's `bundle_deploy` hook calling Ronin's `/admin/clients/register` endpoint). It uses the same patient-context flows as any third-party SMART app: patient authenticates via the customer's IdP; portal receives `id_token` + `access_token` + `refresh_token`; portal scopes are `patient/Consent.cruds patient/Patient.rs patient/Organization.rs patient/AuditEvent.rs launch/patient openid fhirUser offline_access`.

The portal is not privileged beyond what a third-party app could be granted. This matters: a customer running a headless mode (no Ronin portal) builds an equivalent UI against the same auth surface.

#### 3.3 Push contract

The portal creates Consents via standard FHIR `POST /Consent` calls authenticated with the patient's session token. Conditional create + conditional update apply per ADR-0011: an opt-out Consent for the same `(patient, scope, target_api)` tuple is idempotent.

### 4. Permitted Purpose of Use (PPOU) vocabulary

| Purpose code | System | Use case |
|---|---|---|
| `TREAT` | v3-ActReason | Provider Access; EHR launch; clinical workflows |
| `HPAYMT` | v3-ActReason | Claim processing; eligibility verification |
| `HOPERAT` | v3-ActReason | Quality measurement; fraud detection; care management |
| `HRESCH` | v3-ActReason | Research use — requires explicit Consent |
| `HMARKT` | v3-ActReason | Marketing — explicit Consent required; default deny |
| `ETREAT` | v3-ActReason | Emergency treatment — break-glass; per ADR-0016 §3.2 |
| `PSYCHRES` | v3-ActReason | Mental health-specific restriction context |
| `PATRQT` | v3-ActReason | Patient request for their own records |
| `COVERAGE` (Ronin extension code system `http://terminology.ronin.health/CodeSystem/ronin-purpose-of-use`) | Ronin extension | CMS-0057 Payer-to-Payer transfer purpose (no existing v3-ActReason code covers this exactly) |

The Ronin extension code system is documented in the conformance artifacts shipped with the bundle. CMS-0057-F doesn't mandate a specific code system for the Payer-to-Payer purpose; the Ronin extension is interoperable via the standard `system` + `code` Coding pattern. When HL7 publishes a canonical code, the extension deprecates with a ConceptMap.

### 5. Read-time filter — the enforcement gate

This is the point 5 referenced from ADR-0006 §5. Runs after scope checks (points 1–4) pass; operates on the data being returned, not just the request shape.

#### 5.1 Inputs

| Input | Source | Format |
|---|---|---|
| Requester scope set | RFC-7662 introspection at point 1 of ADR-0006 §5 | List of canonical v2 scopes |
| Requester identity | IdP-issued OIDC claims | `sub`, `fhirUser`, `roles`, `organization` claims |
| Claimed purpose of use | Request header `X-Purpose-Of-Use` (per HL7 conventions) or claim in the access token | One of §4's codes |
| Patient compartment scope | `launch_context.patient` from SMART | `Patient/fhir_id` |
| Active Consents | `gold.consent_r4_current` query: WHERE patient_id = compartment_patient AND status = 'active' AND now() BETWEEN provision_start AND provision_end | Rows with denormalized columns from §1 |
| Resource `meta.security` labels | Denormalized columns from ADR-0015 Amendment 2 §A2.2 on each result row | `confidentiality_level`, `sensitivity_tags`, `policy_tags` |

#### 5.2 Computation

```
1. Compute (clearance_ceiling, permitted_sensitivities) = ronin.security.compute_clearance(scope_set, active_consents, purpose_of_use)
   -- Per ADR-0015 Amendment 2 §A2.6 UC Function.

2. For each candidate row in the query result set:
   a. Multi-level security check: row.confidentiality_level must be <= clearance_ceiling
      using the HCS total-order V > R > N > M > L > U.
      Fail → exclude row.
   b. Sensitivity check: row.sensitivity_tags must be a subset of permitted_sensitivities.
      Fail → exclude row.
   c. Consent provision evaluation: walk the nested provision tree of the matching
      Consent(s). For each provision whose securityLabel intersects row.sensitivity_tags
      AND whose purpose intersects the claimed purpose AND whose actor matches the
      requester organization/role: collect permit/deny.
      Innermost matching provision wins. Deny outranks permit at the same nesting level.
      Net deny → exclude row.

3. Return surviving rows. Excluded rows go to AuditEvent per §5.4.
```

The query layer translates the per-row predicates into a SQL `WHERE` clause that runs in the Gold projection read; per-row evaluation in Python/TS is reserved for the (rare) cases that need the full provision tree walk. Multi-level security and the sensitivity-tag intersection are pure SQL.

#### 5.3 Performance posture

- Per-request: one UC Function call to `compute_clearance` (returns ~5KB tuple).
- Per-result-row: SQL predicate evaluation against the denormalized columns. O(1) per row at the warehouse layer; no row-by-row Python.
- Per-Consent: one `WHERE` clause per Consent provision tree. The provision tree depth is typically shallow (most CMS-0057 Consents are 1-2 levels deep).
- Worst case: a patient with 50 Consents and a `system/Patient.rs` query against 100K Observations. Bench-tested in the operability ADR's load testing; the denormalized columns + partition pruning + Z-order keep the gate sub-second.
- **No cache for v1.** Active Consents read at request time, not cached. Trade vs. cache: simplicity + correctness. Revocation is effective on the next request, period. v1.x may introduce a per-patient consent cache with TTL or push invalidation when customer demand surfaces.

#### 5.4 AuditEvent on exclusion

When the gate filters resources, the response goes out with no indication those resources existed (data segmentation per DS4P). The auditor's view captures the truth:

- One AuditEvent per request with `outcome = 0` (success) and `entity[]` listing each returned-resource fhir_id.
- A separate `requested-but-restricted-by-consent` AuditEvent with `entity[]` listing each excluded-resource fhir_id, `agent.policy[]` pointing at the matched Consent fhir_id(s), and `detail.applied_provisions[]` enumerating which provisions caused the exclusion.
- Per ADR-0016 §2.1.1, both AuditEvents land in the same audit surface; the second is queryable by auditors for compliance investigations.

### 6. Revocation propagation + lifecycle

Consents are full FHIR resources — versioned per ADR-0010; `_history` available; standard CRUD semantics.

- **Revoke** = create a new Consent version with `status = inactive` or with a restrictive provision (per FHIR Consent spec; both patterns are valid).
- **Propagation latency** = within one request. Per §5.3, no cache; the gate reads `gold.consent_r4_current` at request time. The new active version surfaces immediately.
- **Per-API lifecycle:**
  - **Patient Access** — patient is the requester; opt-out is uncommon (patients consenting to their own data). When invoked, opt-out applies persistently until reversed.
  - **Provider Access** — opt-out is persistent until reversed. Provider organizations re-checked at each request.
  - **Payer-to-Payer** — opt-in valid for the specific transfer event; expires after the configured window (default 30 days; `ronin_p2p_consent_default_window`).
  - **`$member-match`** — per-transaction; HRex spec says recipient SHOULD store the params for subsequent authorization-server checks. Ronin stores them as a Consent provision with `period` matching the transaction window.

### 7. Portal v1 scope — minimum viable patient experience

#### In v1:

- **Opt-out for Provider Access** — one-click toggle with confirmation; creates Consent with `provision.deny` + `actor.role = Provider` + `purpose = TREAT`.
- **Opt-in for Payer-to-Payer** — per-transfer authorization with target-payer selection; creates Consent with `provision.permit` + `period` + `actor.reference = target_payer` + `purpose = COVERAGE`.
- **View existing Consents** — list of active + history (per ADR-0010 `_history`).
- **Revoke any Consent** — creates new Consent version with `status = inactive`.
- **View "Apps connected to your account"** — registered SMART clients + scopes granted + last-access timestamp from the OAuth event log.
- **Render CMS-required educational materials** — content bundle from §10; HTML or PDF served from the App.
- **AuditEvent self-view** — patient can see their own access log per ADR-0016 §1 (patient-transparency surface).

#### Deferred to v1.x:

- Per-resource granular consent ("share my Conditions but not my Observations").
- Multilingual + accessibility audit (WCAG 2.1 AA — targeted but not certified in v1).
- Native mobile (web responsive only for v1).
- Caregiver / proxy access flows.
- Pediatric / minor patient flows.
- Patient-side `meta.security` label visualization (advanced users).
- Family / household consent linking (cluster B from a future ADR).

### 8. Back-office operator surface — API only in v1

Payer staff capture Consent on behalf of patients via phone or paper. v1 ships the API; v1.x ships the UI.

- **API:** standard `POST /Consent` with `Consent.performer` = the staff user's `Practitioner/PractitionerRole` reference, `Consent.note[]` capturing the channel ("phone", "paper-mail") + the staff user's free-text notes. Goes through the same scope-enforcement gate as any other write.
- **AuditEvent:** captures the staff user's identity + the original patient identity per ADR-0016 §5.
- **Tracking:** `gold.installation_audit` (per ADR-0016 §5.2 follow-up) extends with consent-recorded-by-staff entries for compliance reporting.

A dedicated operator portal App lands in v1.x when customer demand surfaces. Same `Consent` storage; different UI surface.

### 9. Portal tech stack — TypeScript / React + headless contract

| Mode | Description | Default for |
|---|---|---|
| **Themed App (default)** | TypeScript + React (matching the FHIR server App's stack from ADR-0013). Brand-themable via CSS + content bundle. Smaller payers deploy as-is. | `payer_baseline` |
| **Headless** | Customer hosts their own member portal; consumes Ronin's FHIR + Consent + discovery surfaces. Ronin ships the contract documentation; no Ronin-side UI. | Larger payers with existing portals |

Headless mode is the documented capability, not a separate App. Setting `ronin_patient_portal = headless` in the deployment variables tells the DAB to skip the portal App's deploy. The Consent + scope-enforcement gate doesn't care which UI created the Consent; it enforces against any incoming write.

### 10. CMS-required educational materials

CMS-0057 requires payers to disseminate plain-language information about API data exchange benefits + the patient's ability to opt out of Provider Access and opt in to Payer-to-Payer. Ronin doesn't provide content; the customer does.

| Deployment variable | Type | Default |
|---|---|---|
| `ronin_educational_materials_bundle_uri` | UC volume URI to a Markdown/HTML bundle | empty (deployment must populate before going live) |
| `ronin_educational_materials_supported_languages` | array of language codes | `["en"]` |

The portal renders the materials at standard URLs (`/portal/learn/provider-access`, `/portal/learn/payer-to-payer`, `/portal/learn/your-rights`). Customer content; Ronin URL convention. Operability ADR documents the content-bundle expected structure.

## Consequences

**What this commits Ronin to:**

- A second Databricks App alongside the FHIR server App in the v1 GA bundle (themed mode; not deployed in headless mode).
- A new Consent enforcement gate at the read path layer, evaluated per request per row.
- A documented headless contract that larger payers consume; the contract becomes a stability commitment.
- Bronze→Silver Governance step gets a sibling layer (the SLS per ADR-0015 Amendment 2) that produces the labels this ADR consumes.
- CMS-0057 dual consent obligations (Provider Access opt-out + P2P opt-in) are implemented end-to-end at GA.

**What it enables downstream:**

- 42 CFR Part 2 + state behavioral health + reproductive health + HIV segmentation work without further architecture changes — only SLS rule additions.
- TEFCA cross-QHIN consent enforcement plugs into §5's gate; the TEFCA participation ADR adds cross-QHIN-specific provisions on top.
- Customer-side AI agent for unmapped consent provisions (per ADR-0012 §7's HITL pattern) reuses the gate's audit surface.

**What it costs:**

- Additional Databricks App in the bundle increases the deploy surface by one unit (themed mode only).
- Consent gate adds one read-side compute step on every FHIR read. Mitigated by ADR-0015 Amendment 2's denormalized columns + partition pruning.
- Customer-content responsibility for educational materials. Mitigated by reasonable defaults documented in the operability ADR.
- The portal App's frontend ownership is non-trivial; CSS theming + content bundles are a customer-facing API stability surface.

## Alternatives considered

- **Patient portal as a third-party Ronin partner** (not Ronin-shipped). Rejected — too high a friction barrier for smaller payers; defeats the single-deployment-unit story.
- **Stamp consent state on every resource at write time.** Rejected — bloats every resource; consent state changes more often than resource state.
- **Cache active Consents in the TS App.** Rejected for v1 — revocation propagation correctness trumps a few ms per request; revisit in v1.x with explicit cache invalidation design.
- **Skip the headless contract; force themed portal usage.** Rejected — alienates larger payers with existing member portals; defeats the "Ronin is the data platform, not the UX" framing.
- **Use a custom consent-enforcement code system** instead of v3-ActReason + Ronin extension for the P2P purpose. Rejected — fragments the FHIR interoperability story; the extension code is a transparent bridge until HL7 publishes a canonical code.
- **Consent gate at the SQL layer only** (no per-request UC Function call). Rejected — the clearance computation needs IdP context that doesn't live in the warehouse; a hybrid (UC Function for clearance + SQL predicates for per-row) is the right split.
- **Bundle SLS into this ADR** instead of ADR-0015 Amendment 2. Rejected per session 019 — SLS rule engine is structurally identical to ADR-0015 Layer C; co-locating them is the right engineering reuse.

## Follow-up ADRs queued

- **TEFCA participation ADR** — cross-QHIN consent precedence reconciliation; TEFCA Patient IAL2 workflow; QHIN-specific audit export schedules.
- **Pediatric / minor patient flows** — special-population scope policy + portal UX for minors + caregiver delegation.
- **v1.x consent cache + push invalidation** — when load testing surfaces the no-cache cost; explicit cache design + invalidation push semantics.
- **Operator portal App** — back-office consent-capture UI; depends on customer demand.
- **Consent + cross-version FHIR climb** — when Ronin climbs to FHIR R5/R6, Consent semantics change (R5 introduced Consent.decision); cross-version translation rules.
- **CMS Payer-to-Payer purpose code canonicalization** — replace the Ronin extension with HL7's canonical code when published; deprecation choreography.
- **gold.installation_audit table design** (per ADR-0016 §5.2 follow-up) — extended to cover consent-recorded-by-staff entries.

## Open questions not closed by this ADR

- **Pediatric / minor patient scope policy** — when a parent has access to a minor's portal vs. an adolescent's own access (state laws vary widely); deferred to the special-population ADR.
- **Substance use disorder Consent under SAMHSA 2024 final rule** — the rule aligned 42 CFR Part 2 with HIPAA for TPO after explicit patient consent, but the segmentation requirement remains. Implementation specifics belong in a SAMHSA-compliance follow-up.
- **Headless-portal compliance attestation** — when a customer runs headless, who attests that the customer's portal meets CMS-0057 educational-materials + opt-out-UI requirements? Likely a deployment-time attestation in `installation_audit`; concrete design in the Operability ADR.
- **Multi-tenant consent sharing** — two payer tenants on the same Ronin instance, same patient. Out of scope for v1; revisits when multi-tenancy lands.
- **Consent for `$everything` operation** — Patient/$everything returns a Bundle that crosses many resource types; gate evaluation happens per-result-resource, but the operation-level scope check semantics need ratification. Likely an Operability ADR concern.

## Sources

- [FHIR R4 Consent Resource](https://hl7.org/fhir/R4/consent.html) — canonical spec
- [FHIR R4 Security Labels](https://hl7.org/fhir/R4/security-labels.html) — meta.security shape
- [Security Labeling Conceptual Structure — FHIR DS4P v1.0.0](https://build.fhir.org/ig/HL7/fhir-security-label-ds4p/security_labeling_conceptual_structure.html) — HCS operationalization
- [HL7 Healthcare Privacy and Security Classification System (HCS), Release 1](https://www.hl7.org/implement/standards/product_brief.cfm?product_id=345) — conceptual framework
- [v3-Confidentiality CodeSystem](https://terminology.hl7.org/CodeSystem-v3-Confidentiality.html) — total-order hierarchy
- [v3-InformationSensitivityPolicy ValueSet](https://terminology.hl7.org/ValueSet-v3-InformationSensitivityPolicy.html) — sensitivity categories
- [v3-ActReason / PurposeOfUse](https://terminology.hl7.org/ValueSet-v3-PurposeOfUse.html) — PPOU code system
- [Da Vinci HRex Consent Profile](https://build.fhir.org/ig/HL7/davinci-ehrx/StructureDefinition-hrex-consent.html) — `$member-match` consent shape
- [Da Vinci PDex Payer-to-Payer Exchange](https://www.hl7.org/fhir/us/davinci-pdex/PayerToPayerExchange.html) — P2P flow
- [CMS-0057-F final rule](https://www.cms.gov/files/document/cms-0057-f.pdf) — opt-in / opt-out obligations
- [CMS Interoperability and Prior Authorization fact sheet](https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-prior-authorization-final-rule-cms-0057-f) — educational-materials requirement
- [HIPAA TPO Disclosures (HHS)](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/disclosures-treatment-payment-health-care-operations/index.html) — HIPAA permitted purposes
- [42 CFR Part 2](https://www.law.cornell.edu/cfr/text/42/part-2) — substance use disorder confidentiality
- [Sensitive Data Handling — Rules Engine to Tag FHIR Data (Outcome Healthcare)](https://outcomehealthcare.com/sensitive-data-handling/) — production SLS pattern reference
- ADR-0006 §5 point 5 — the gate this ADR provides
- ADR-0015 Amendment 2 — the SLS labels this ADR consumes
- ADR-0016 §2.1.1 + §8.1 — audit surface for excluded-resource recording
- ADR-0017 §9 — discovery contract that the portal extends
