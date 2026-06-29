# ADR-0012: Master Patient Index — Deterministic v1, Splink v2 with Guardrails, PPRL v1.x, HITL Review Queue

- Status: **Accepted**
- Date: 2026-06-19
- Decider(s): Chad
- Session: 014
- Related: [ADR-0008](0008-updated-vision-and-scope.md) §D8 (narrow MDM v1), [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md), [ADR-0010](0010-storage-shape.md) (Amendments 1 + 2), [ADR-0011](0011-write-contract.md) (Amendments 1 + 2), [docs/research/2026-06-19-bronze-to-silver-governance.md](../research/2026-06-19-bronze-to-silver-governance.md), [docs/research/2026-06-19-empi-mdm-landscape.md](../research/2026-06-19-empi-mdm-landscape.md), [docs/research/2026-06-19-ronin-mpi-design.md](../research/2026-06-19-ronin-mpi-design.md)

## Context

ADR-0008 §D8 set the v1 MPI posture as "narrow" — deterministic exact business-identifier match, latest write wins. Sessions 011–014 broke this out concretely:

- ADR-0010 + ADR-0011 Amendments 1 introduced Bronze as a thin transactional tier owning Conditional Create/Update via a local identifier shortcut.
- ADR-0010 + ADR-0011 Amendments 2 collapsed Silver back into Gold; one Governance transformation between Bronze and Gold.
- The [Bronze→Silver Governance research note](../research/2026-06-19-bronze-to-silver-governance.md) designed the Governance step including MPI (§A), merge (§B), unmerge (§C), and the intra-batch ordering edge cases (§K).
- The [EMPI/MDM landscape survey](../research/2026-06-19-empi-mdm-landscape.md) anchored against 2026 reality: TEFCA has 11 designated QHINs; healthcare operations query response (HEDIS, quality measures) required by February 2026; Verato dominates the commercial EMPI/hMDM market; Splink is the leading lakehouse-native probabilistic linkage library; Datavant Connect already integrates with Databricks for PPRL tokenization.
- The [Ronin MPI design research note](../research/2026-06-19-ronin-mpi-design.md) selected the algorithm path, table shapes, integration model, and v1 → v2 evolution.

Chad's session-014 calls (paraphrased): "I agree with PPRL support. I'm OK with Splink, but need solid guardrails and a review queue for human in the loop." This ADR ratifies the design.

## Decision

### 1. Two-stage match decision flow

**Deterministic always preferred; probabilistic only when deterministic doesn't decide.** Rationale: deterministic decisions are explainable, auditable, and fast — and clinically safer because wrong merges of two real people contaminate medical history. Splink (v2+) extends matching coverage when deterministic data is insufficient; it does not override deterministic logic.

```
incoming Patient at Governance
  ↓
Stage A: Deterministic match
  Run configured rule set against gold.patient_link
    Zero matches → mint new fhir_id (Create)
    Single match → assign existing fhir_id (Update); confidence = 1.0
    Multi-match (≥2 distinct fhir_ids) → enter patient_match_review; hold in Bronze
  ↓ (if zero matches and probabilistic enabled, fall through)
Stage B: Probabilistic match (Splink; v2+)
  Blocking-rule-constrained candidate set
  Three-band threshold:
    Score ≥ auto_match_threshold (default 0.95) → assign existing fhir_id
    review_threshold (default 0.70) ≤ score < auto_match → enter patient_match_review
    Score < review_threshold → mint new fhir_id (Create)
  ↓
Hard-deny guardrails enforced at both stages (§3.4 + §4.4)
  ↓
Audit Provenance written for every decision (§5)
  ↓
Promote to Gold (or hold in Bronze for review)
```

### 2. The MPI table set (all Gold)

All MPI tables live in Gold under `ronin_<warehouse>.gold.<table>`. The Bronze-local `bronze_identifier_shortcut` from ADR-0011 Amendment 1 caches `patient_link` lookups for synchronous Conditional Create/Update; fed by Bronze writes (provisional) and reconciled from `patient_link` (authoritative).

**`gold.patient_link`** — authoritative identifier → Ronin Patient `fhir_id` map. Append-only. Keyed on `(identifier_system, identifier_value, resource_type)`. Carries `fhir_id`, `is_active`, `provisional`, `superseded_link_fhir_id`, `assigned_at`, `assigned_by_governance_run`, `decision_path` ("deterministic_rule:<name>" | "probabilistic_auto" | "review_approved" | "manual_create"), `match_score`. Partitioned by `identifier_system` hash bucket (16 default).

**`gold.patient_match_review`** — operator-facing HITL review queue for ambiguous matches. Append-only with status transitions modeled as new rows. Carries `review_id` (UUID v7), `review_version_id` (monotonic), `bronze_ingest_id`, `incoming_identifiers`, `candidate_matches` (array of `<fhir_id, score, decision_path, evidence_summary>`), `suggested_action`, `status` (pending | approved | rejected | auto_escalated | auto_aged_out), `reviewer_id`, `decided_at`, `decision_action`, `decision_reason`, `ttl_expires_at`, `escalation_role`, `governance_pipeline`. Partitioned by `(status, year_month(decided_at))`. Includes a side-by-side **evidence summary snapshot** (rendered demographics) at review-creation time so the steward UI doesn't have to re-fetch each candidate.

**`gold.patient_merge_history`** — audit and reversal substrate. Append-only. Carries `merge_id`, `surviving_fhir_id`, `merged_fhir_id`, `merged_at`, `merge_reason`, `merge_actor` (system | operator:<reviewer_id>), `splink_score` (nullable), `splink_model_version` (nullable), `unmerge_id` (nullable), `unmerged_at`, `unmerge_actor`, `unmerge_reason`. Partitioned by `year_month(merged_at)`.

**`gold.pprl_tokens`** (v1.x) — tokenization output for cross-org TEFCA matching. Append-only. Carries `patient_fhir_id`, `token_system` (e.g., `datavant:standard` | `clk:openhie` | deployment-config), `token_value` (opaque cryptographic output), `token_pipeline_version`, `generated_at`, `deleted`. Partitioned by `token_system`.

**`gold.mpi_decision_log`** (v2) — per-attribute m-probability and u-probability contributions to each Splink score. Enables post-hoc threshold tuning and accuracy investigation. Partitioned by `year_month(decided_at)`.

### 3. v1 deterministic rule engine

**Rule DSL** — YAML configurable per deployment. Rules ordered; first match wins; ties broken by recency. Each rule has a `name`, `description`, `conditions[]`, `action` (`auto_match` | `review`), and `confidence` (1.0 for deterministic auto-match).

Three shipped default profiles:

- **Payer profile** (10M-member payer baseline): `member_id_only` → `ssn_dob_name` → `member_id_plus_dob` → `ambiguous_demographics` (review).
- **Healthcare provider profile** (IDN baseline): `same_assigning_authority_mrn` → `mrn_plus_dob_cross_facility` → `ssn_dob_name` → `ambiguous_demographics` (review).
- **Strict profile** (federal payers, government health systems): identifier-based only; demographic-based always to review.

Customers extend or override per deployment. Defaults are versioned; changes require deployment-pinned upgrade.

**Identifier normalization** runs before any rule fires: system URI canonicalization (lowercase scheme + host, strip trailing slash); value format checks per system (NPI = 10 digits; SSN format collapsed; MRN per assigning authority); type code validation. Normalization rules are per-deployment-configurable plugins.

### 3.4 Hard-deny guardrails (apply at both deterministic and probabilistic stages)

Floors that reject auto-match regardless of which rule fired or what Splink scored:

| Guardrail | Trigger | Action |
|---|---|---|
| Date-of-death mismatch | Both candidates have `deceasedDateTime`; dates differ by > 14 days (configurable) | Route to review with `manual_review_required` |
| Sex mismatch | Both have `gender`; values differ; neither is `unknown` | Route to review (per-deployment configurable for gender-flexible match) |
| Identifier system reuse across distinct candidates | Same `system+value` appears for distinct candidates | Route to review with `data_quality_issue` flag |
| Conflicting authoritative cross-system identifier | Both have `http://hl7.org/fhir/sid/us-ssn` with different values | Hard distinct (auto-create new; do not match) |
| Inactive Patient | Candidate has `Patient.active = false` (typically a merged-away Patient) | Skip; do not consider as candidate |

These are **not** configurable to disable — they are safety floors. Specific threshold parameters (e.g., 14-day death window) are configurable.

### 4. v2 Splink integration with twelve concrete guardrails

**Architecture.** Splink runs as a PySpark batch job in the Governance DLT pipeline. Triggered only after Stage A produces zero-match. Candidate-pair generation is constrained by blocking rules (without blocking, Splink is O(N²) — fatal at 10M Patients). Three-band score classification → decision.

**The twelve guardrails (mandatory; enforce via deployment config validation):**

1. **Deterministic-first principle.** Splink only runs after deterministic stage produces zero-match. Never overrides a deterministic decision.
2. **Conservative auto-match threshold default.** `auto_match_threshold` defaults to 0.95 (normalized Fellegi-Sunter probability). Customer can tighten upward without acknowledgment; loosen to 0.90 with explicit acknowledgment; below 0.90 not permitted.
3. **Wide manual review band.** `review_threshold` defaults to 0.70. Bias toward HITL when uncertain.
4. **Hard-deny rules apply at both stages.** §3.4 guardrails enforced post-Splink; high-score matches that violate hard-deny routed to review with `safety_override` flag.
5. **Blocking rules constrain candidate pairs.** Deployment-configurable but must produce tractable candidate-pair counts (validated by a pre-run sanity check; aborts if estimated pairs > deployment cluster capacity).
6. **Splink model artifact versioning.** Production weights file is a versioned Delta-table-backed artifact (or MLflow model registry entry). Deployment pins a specific version; upgrades require explicit operator action.
7. **EM retraining offline and operator-approved.** Splink's Expectation-Maximization model fitting runs offline on a sample of the customer's data; produces a new artifact; lands in a staging slot; production cutover requires operator approval. Prevents silent model drift.
8. **Audit Provenance per decision.** Every probabilistic-auto-match generates a Provenance resource with: Splink model version, weights breakdown, feature evidence, blocking criteria, candidate set size, decision path.
9. **`gold.mpi_decision_log` per-attribute feature breakdown.** Beyond Provenance, the table records per-attribute m-probability and u-probability contributions for post-hoc tuning and accuracy investigation.
10. **Per-deployment resource quotas.** Splink Spark jobs run under deployment-configured `max_executors` / `max_executor_memory_gb`. Can't starve the rest of Governance.
11. **Rollback procedure.** A deployment can pin to a prior weights file and re-run Governance against the affected Bronze partition window. Bronze immutability + Provenance/log records make scope-of-impact identification tractable.
12. **Cross-assigning-authority threshold tighter than within-system.** Probabilistic match where candidates come from different MRN systems requires a higher auto-match threshold (default 0.97 vs. 0.95). Cross-system matches are riskier (legitimate distinct people with similar demographics often appear at different facilities).

**Splink configuration shape** (per-deployment YAML): `enabled` (v2 gate), `model_artifact`, three threshold values (`auto_match_threshold`, `review_threshold`, `cross_assigning_authority_threshold`), `blocking_rules[]`, `features[]` (with `comparison` + `weights: { match, mismatch }`), `resource_quota`.

**EM retraining workflow:** operator-triggered `ronin mpi retrain --sample-size N --output-slot staging`; weights diff tool; dry-run scoring on recent Patients; operator approval; deployment config flips to new artifact version. Not on the runtime hot path.

### 5. HITL review queue mechanics

**What the steward sees per `patient_match_review` row in `status = 'pending'`:**

- Side-by-side rendered demographics (name, DOB, gender, address, phone, email, identifiers, preferred language) from the incoming row and each candidate Patient.
- Decision-path explanation (which deterministic rule fired, or which Splink features contributed and their weights).
- Suggested action from the system.
- A free-form note field; optional coded reason vocabulary per deployment.

**Operator UI is v2+ scope for Ronin to build.** v1 ships the table contract. Customer-side stewards consume via Databricks SQL queries, build their own UI, or integrate a vendor stewardship UI (Verato's UI, NextGate's, etc.).

**Decision capture** — steward writes a new row with the decision:

- **Approve merge** → `status='approved'`, `decision_action='merged_to:<fhir_id>'`. Governance picks up next run and applies merge per Bronze→Silver Governance note §B.
- **Approve distinct** → `status='approved'`, `decision_action='created_new:<fhir_id>'`. Governance mints fhir_id and updates `patient_link`.
- **Reject** → `status='rejected'`. Incoming Patient held in Bronze permanently as unresolved.
- **Escalate** → `status='escalated'`, `escalation_role='senior_steward'|'physician'|'compliance'`.

**TTL and escalation policy.** Default 7-day TTL on `pending`; auto-escalate to senior steward on expiry; senior TTL 14 days; second expiry → `auto_aged_out` with observability flag. Strict deployments may auto-reject on expiry; permissive deployments may extend TTLs.

**Bulk dedup workflow** — operator-triggered `ronin mpi bulk-dedup --candidate-source <bronze-window> --time-window Nd`. Runs Splink against historical Bronze partitions; results land in `patient_match_review` with `bronze_ingest_id = NULL` and a `bulk_dedup_run_id` correlation. Stewards bulk-approve/reject with filterable criteria. Same guardrails as runtime.

### 6. PPRL integration (v1.x)

**Pattern.** Tokenization runs in the customer's Databricks workspace (Datavant Connect-compatible pattern). Tokens land in `gold.pprl_tokens` and become an additional identifier surface in `bronze_identifier_shortcut` and `gold.identifier_index`. Cross-org matching uses the same `$match` interface; tokens are just additional identifier system URIs. Forward-compatible with Datavant, CLK-based, or future MPC-based providers — Ronin treats the token as opaque identifier value.

**Key management is customer-controlled.** Tokenization keys live in the customer's Databricks workspace. Customer rotates keys per vendor SLA; rotated tokens land with new `token_pipeline_version`. Old tokens marked `deleted = true` after QHIN overlap window. Ronin sees only opaque token values; no exposure to PHI-in-the-clear from tokenization.

**Datavant-specific.** Datavant Connect's Databricks integration already exists; payer-customer lift is configuration: point Datavant Connect at Bronze Patient incoming_identifiers; configure output to `gold.pprl_tokens`; turn on.

**Why v1.x and not v2.** TEFCA's February 2026 healthcare operations query response milestone is already in effect (as of this ADR's date, 2026-06-19). Payer customers participating in TEFCA QHIN networks need PPRL for cross-org HEDIS / quality-measure queries.

### 7. `$match` and `$member-match` operations in v1

Both ship in v1 even with deterministic-only backing. The operation interfaces are forward-compatible with both deterministic (v1) and probabilistic (v2+) backends.

**`POST /fhir/{ver}/Patient/$match`** — FHIR R4+ generic MPI lookup. Request: `Parameters` with `resource` (partial Patient) + `count` + `onlyCertainMatches`. Response: `Bundle.type = "searchset"` with one entry per candidate, ordered by descending `search.score`, with `match-grade` extension (`certain` / `probable` / `possible` / `certainly-not`).

**`POST /fhir/{ver}/Patient/$member-match`** — Da Vinci HRex / CARIN BB profile; payer-specific. Request: `MemberPatient` + `CoverageToMatch` + `CoverageToLink`. Response: Bundle with matched Patient + Coverage. Required by CMS-0057-F Payer Access; AWS HealthLake supports it; Ronin should too.

**Strict response semantics per HRex** ([`2026-06-21-coverage-deep-research.md`](../research/2026-06-21-coverage-deep-research.md) §2):
- Exactly one match → `200` with the matched Patient + Coverage.
- No match → `422 Unprocessable Entity`.
- Multi-match → `422 Unprocessable Entity`.

`$member-match` therefore **diverges from generic `$match`** at the multi-match outcome: `$match` returns a candidate list ordered by `search.score`, and Ronin's deterministic-multi-match flow routes to `patient_match_review` for stewardship. `$member-match` does NOT take that path — it returns 422 immediately and writes nothing. The MPI backend produces the candidate set; the `$member-match` adapter checks `|candidates| == 1` and emits 422 if not, while `$match` returns the full candidate list. Same MPI; two adapters.

**Coverage-create anti-pattern (do NOT auto-persist `CoverageToMatch` or `CoverageToLink`).** Both Coverage parameters in the request are ephemeral matching artifacts, not writes. A naive implementation could POST them through to `CoverageRepository.create()`; Ronin's `$member-match` adapter MUST NOT do this. The matched Coverage returned in the response is the responding payer's pre-existing record looked up via the MPI — never a synthesis of the requester's input. v1 ships an integration test asserting that `$member-match` traffic produces no Bronze Coverage rows. (Same anti-pattern applies to `MemberPatient`: it's matched against, not persisted.)

**`meta.profile` stamping on response.** When `$member-match` runs inside the Payer-to-Payer flow, the matched Coverage in the response Bundle is profiled as **HRex Coverage** (not C4BB-Coverage); the Patient is profiled as US Core Patient. The response-shape selector lives in the `$member-match` adapter and is driven by the operation context, not by stored `meta.profile`.

**`POST /fhir/{ver}/Patient/$bulk-member-match`** (v1.x) — async variant; returns `202 Accepted` + `Content-Location` for status polling; results land in NDJSON in UC Volume (same pattern as `$import` per ADR-0011 §3a). The same 422-on-not-exactly-one rule applies per result row; the bulk file contains a mix of resolved matches and 422-equivalent "no-or-multi-match" rows tagged for the caller.

### 8. Audit / Provenance generation

Every MPI decision generates a FHIR `Provenance` resource. Provenance has its own Bronze + Gold tables; queryable like any FHIR resource. Reverse-search by `Provenance.target` returns full MPI history of a Patient.

| Decision | Provenance.target | Provenance.activity | Provenance.agent | Provenance.what |
|---|---|---|---|---|
| Deterministic auto-match | Updated Patient | `MATCH` | `system` | Rule name; matched identifier(s) |
| Probabilistic auto-match | Updated Patient | `MATCH` | `system` | Splink score, model version, feature breakdown |
| Manual merge approval | Both merged Patients | `MERGE` | `operator:<reviewer_id>` | review_id, decision_reason |
| Manual distinct (created new) | Newly minted Patient | `CREATE` | `operator:<reviewer_id>` | review_id |
| Unmerge | Both un-merged Patients | `UNMERGE` | system or operator | Reversed merge_id, reason |
| Rule/model reprocessing | Affected Patients | `UPDATE` | `operator:<actor>` | Reprocessing run id, pipeline version diff |

### 9. Reprocessing semantics

Customers may re-run MPI against historical Bronze data when rules or models change. Trigger: `ronin mpi reprocess --bronze-window YYYY-MM-DD..YYYY-MM-DD --pipeline-version <new>`. Bronze immutability supports it. New decisions land as appended rows in `patient_link`, `patient_match_review`, `patient_merge_history`. Provenance records the reprocessing run id. Decisions deduped by `(bronze_ingest_id, governance_pipeline)`; same pipeline version is idempotent.

**Safety:** reprocessing can produce auto-merge decisions that disagree with prior decisions. Surface via observability ("reprocessing run X produced N decision deltas, M merges") and **require operator acknowledgment before applying** the deltas.

### 10. Bundle / MPI interaction

Transaction Bundles (single-resource-type v1 per ADR-0011 §change 3) containing a Patient + same-type referencing resources (e.g., multiple Observations on one Patient via a Patient-then-Observations Bundle is a separate case for v1.x cross-resource scope; in v1 the same-type case is what's possible):

**Bronze stage:** mint `fhir_id`s for new resources; resolve Conditional Create/Update against `bronze_identifier_shortcut`; rewrite intra-bundle References; commit Bundle atomically.

**Governance stage:** runs MPI on Patient (Stage A → Stage B if needed). If MPI confirms Bronze-provisional decision, Patient + referencing resources promote to Gold. If MPI disagrees (Bronze "Create" but Governance "Update against existing"), patient merge runs; Observations are re-pointed to survivor Patient via append-only update.

**Multi-match edge case:** if Stage A produces multi-match, Patient enters `patient_match_review`. Referencing resources from the same Bundle promote to Gold with `patient_id = NULL` (unresolved). When steward resolves, a reprocessing pass updates the references to point at the resolved `patient_id`. Consistent with Bronze→Silver Governance research note §K (two-pass batch ordering) and session-008 load-but-unresolved decision.

### 11. v1 → v2 evolution path

| Capability | v1 | v1.x | v2 | v2.x |
|---|---|---|---|---|
| Deterministic rule engine | ✅ | ✅ | ✅ | ✅ |
| `$match` + `$member-match` | ✅ | ✅ | ✅ | ✅ |
| `$bulk-member-match` async | — | ✅ | ✅ | ✅ |
| `gold.patient_link` + `gold.patient_merge_history` | ✅ | ✅ | ✅ | ✅ |
| `gold.patient_match_review` table | ✅ (det-multi-match only) | ✅ | ✅ (det + prob) | ✅ |
| Splink probabilistic backend | — | — | ✅ | ✅ |
| Twelve guardrails | — | — | ✅ (mandatory) | ✅ |
| HITL stewardship table contract | ✅ | ✅ | ✅ | ✅ |
| Ronin-built stewardship UI | — | — | — | ✅ |
| PPRL tokens (`gold.pprl_tokens`) | — | ✅ | ✅ | ✅ |
| Datavant Connect integration | — | ✅ | ✅ | ✅ |
| Commercial EMPI integration hook (Verato, NextGate) | — | — | ✅ | ✅ |
| FHIR Person resource | — | — | — | ✅ |
| Bulk dedup runs | — | — | ✅ | ✅ |
| Reprocessing with delta acknowledgment | ✅ basic | ✅ | ✅ | ✅ |

## Consequences

- **v1 ships deterministic-only MPI** with `$match` + `$member-match` operations and the HITL review queue table contract. The forward-compatible interface lets customers begin building stewardship UIs against the table contract on day one, with no breaking changes when v2 enables probabilistic backing.
- **v1.x adds PPRL.** TEFCA-participating payer customers will need it; the Datavant Connect integration pattern is already documented and low-lift.
- **v2 adds Splink with twelve mandatory guardrails.** The guardrails enforce a high safety floor (deterministic-first, conservative thresholds, hard-deny rules at both stages, audit Provenance per decision, operator-approved model versioning) at the cost of rejecting some legitimate auto-matches. The review queue catches the rejected matches; HITL is the trade-off.
- **Customer-side Governance pipeline complexity increases.** Customers now run a Splink-on-PySpark stage, an EM retraining workflow, and a stewardship workflow. [ADR-0019 §9](0019-storage-and-pipeline-operations.md) ratifies the MPI operations defaults (quarterly EM retrain; stewardship SLOs); [ADR-0021](0021-install-audit-and-runbooks.md) covers the operator surface + runbooks.
- **MPI is in Gold.** No separate Silver tier interferes with reasoning about decisions. `gold.patient_link` is the single authoritative lookup; `bronze_identifier_shortcut` is a cache reconciled from it.
- **All MPI decisions are audited via Provenance.** Reverse-search by `Provenance.target` gives the full MPI history of any Patient.
- **Reprocessing is supported but gated.** Bronze immutability allows re-running MPI against historical data; operator acknowledgment is required for decision deltas to prevent silent regression.
- **Survivorship rules during merge are deferred to a follow-up.** Open question #2 in the design note remains open; v1 default is "most recent wins per field" with per-deployment override; finalized in a small operability sub-note.
- **The deterministic rule DSL is YAML.** Per-deployment override is straightforward; defaults shipped for the three baseline profiles (payer / provider / strict).

## Alternatives considered

- **HAPI FHIR MDM as embedded backend.** Rejected — JVM runtime; doesn't fit Ronin's TS + Python/Spark tier model. HAPI's rule-config DSL is reference for the v1 YAML schema; the runtime is not adoptable.
- **Verato as bundled MPI.** Rejected — commercial; design taste (cheap-by-default); integration hook only. Customers wanting Verato run their own Verato endpoint and Ronin's Governance pipeline calls out.
- **Probabilistic-first matching.** Rejected — less defensible to stewards / regulators; harder to audit. Deterministic-first is the safer floor; Splink extends coverage when deterministic data is insufficient.
- **FHIR Person resource as primary representation.** Rejected for v1 — Patient.link is sufficient because Ronin controls the canonical Patient records. Person resource support is v2.x consideration if federation becomes a v2 use case.
- **No `$match` operation in v1.** Rejected — forward-compatibility matters; clients building against v1 should not need to change their code when v2 enables probabilistic backing.
- **PPRL deferred to v2.** Rejected per Chad's session-014 call — TEFCA's February 2026 milestone is already in effect; payer customers need PPRL in v1.x.
- **Probabilistic backend other than Splink** (Dedupe, HAPI MDM, OpenEMPI). Considered. Splink wins because of: PySpark backend (native fit with Databricks); Fellegi-Sunter interpretability (matters for steward audit); active development; established at-scale production references; Apache license.
- **Stewardship UI shipped in v1.** Rejected — v1 ships the table contract only; UI is v2+ scope. Customers run Databricks SQL queries, build their own UI, or integrate vendor stewardship tooling in the interim.
- **`patient_match_review` enforced before any promotion to Gold.** Rejected — Patients promote to Gold normally when MPI auto-matches; only multi-match-ambiguous + probabilistic-review-band cases are held. Referencing resources from a Bundle promote with `patient_id = NULL` when the Patient is held, per §10.
- **Single deployment-global threshold.** Rejected — cross-assigning-authority threshold default tighter (0.97 vs 0.95) reflects real-world risk that legitimate distinct people share demographics across facilities. Guardrail #12.

## Follow-up ADRs queued

- **Operability ADR** — Splink Spark job sizing, EM retraining schedule, stewardship workflow operational SLOs, observability metrics surface, schema migration for MPI tables.
- **Survivorship rules sub-decision** — small operability sub-note finalizing per-field survivorship defaults during merge (whose name, address, phone, email, language wins).
- **v1 conformance targets** — `$match`/`$member-match` profile pins (which CARIN BB / Da Vinci version); test suite anchors.
- **Cross-resource Bundle ADR** — when cross-resource Bundles ship (per ADR-0011 §change 3 deferral), MPI-aware reference resolution semantics need ratification.
- **Person resource support** — v2.x decision; if federation use cases materialize.

## Open questions not closed by this ADR

1. **Splink feature set defaults beyond the illustrative subset.** Phone, address, email, preferred language — what comparison + weights ship as v2 defaults? Per-deployment configurable; defaults matter for new deployments.
2. **Survivorship rules during merge.** Deferred to follow-up sub-decision.
3. **`patient_match_review` long-term retention.** Default 7-year HIPAA-tier suggested; per-deployment configurable.
4. **Bulk dedup safety.** Operator acknowledgment per batch vs trust-the-guardrails-and-apply-with-rollback. Default: operator acknowledgment per batch; configurable.
5. **Cross-version Patient evolution.** When a customer upgrades R4→R5, do MPI decisions apply via Bronze→Gold reprocessing automatically? Recommended: yes for deterministic; require operator ack for probabilistic.
6. **`$match` rate limiting.** Probabilistic `$match` is expensive (Splink scan). Default rate limit per API token; deployment-configurable.
7. **`match-grade` extension band mapping.** Three Ronin bands (auto_match/review/distinct) ↔ four FHIR levels (certain/probable/possible/certainly-not). Mapping per design note §7.1; final wording in `$match` implementation.

## Sources

- [FHIR R5 Patient `$match`](https://www.hl7.org/fhir/patient-operation-match.html)
- [FHIR R6 ballot 4 Patient `$match`](http://build.fhir.org/patient-operation-match.html)
- [Splink — UK MoJ Analytical Services](https://moj-analytical-services.github.io/splink/index.html)
- [Datavant Connect — Databricks integration](https://www.datavant.com/partnerships/cloud-integrations/aws)
- [TEFCA QHIN designations — Sequoia Project](https://rce.sequoiaproject.org/designated-qhins/)
- [AWS HealthLake `$member-match`](https://docs.aws.amazon.com/healthlake/latest/devguide/reference-fhir-operations-member-match.html)
- [AWS HealthLake `$bulk-member-match`](https://docs.aws.amazon.com/healthlake/latest/devguide/reference-fhir-operations-bulk-member-match.html)
- [IHE PMIR v1.6.0](https://profiles.ihe.net/ITI/PMIR/)
- [Verato hMDM platform](https://verato.com/)
- [HAPI FHIR MDM module](https://www.smiledigitalhealth.com/our-blog/announcing-hapi-fhir-empi)
- [Aidbox MPI module](https://www.health-samurai.io/docs/aidbox/modules/mpi/get-started/configure-mpi-module)
