# CLAUDE.md — RoninStandAlone working instructions

## Working agreements (read first)

- **Do not add imaginary requirements.** Never introduce constraints, dependencies,
  components, or edge cases that Chad didn't ask for and that don't trace to a stated
  requirement or the established architecture. If a technical caveat *might* be
  relevant, **ask whether it's in scope** before baking it into designs, ADRs, or
  code — or mark it as an explicit open question, not a decision. Default to the
  simplest thing that meets the actual ask.
  (Example: AWS-S3/DynamoDB multi-writer locking was added to storage ADRs though the
  model is single-writer-per-table and multi-writer was never a requirement — wrong;
  removed.)

- **Working server writing data first; defer the query/management engine.** Build a
  working FHIR server that **writes data** before picking or optimizing a query +
  data-management system. Engine default is **single-engine delta-rs / DataFusion for
  both write and read** (ADR-0022 Amendment 1); **DuckDB was dropped** (an inherited
  assumption, not a real decision). The definitive analytical query/management-platform
  choice is **out of RoninStandAlone's scope** — "we'll get there, but not through
  RoninStandAlone." Don't reopen the engine debate or scope-creep into platform
  selection without a concrete need; the choice is reversible behind the `Warehouse` seam.

## PHI / security standards (in scope)

Build to the applicable PHI standards as we go — **HIPAA Security Rule technical
safeguards** (45 CFR §164.312: access control, audit controls, integrity,
authentication, transmission security), **HITECH** (breach notification, access
accounting), **NIST** (SP 800-66r2, 800-53, FIPS 140-3, SP 800-52 TLS, SP 800-63),
and **federal/health-IT** (ONC (g)(10) API via Inferno, CMS-0057). **Full HIPAA
compliance is not yet in scope but will be required** (BAAs, full admin/physical
safeguards, risk assessment, breach process, ATO/FedRAMP). The security architecture
lives in heritage ADRs (0006 SMART/UDAP, 0016 audit, 0018 consent, 0015 SLS, 0010
integrity); standalone enforcement is nascent.

Non-negotiable working rules:
- **Never put PHI** in logs, error messages, memory files, scratchpad, commit
  messages, or anything sent to an external service.
- **Synthetic data only** for dev/test (Synthea); de-identify before any non-prod use.
- **Encrypt in transit (TLS) and at rest**; **audit + authenticate + authorize** every
  PHI access; enforce **minimum necessary / consent**.
- Secrets via 1Password `op run` only.

(Detail + standard→ADR mapping: project memory `phi-security-standards`.)

## Component disclosure & approval (architecture + product + security)

**Never introduce a dependency, framework, external tool, or service without
disclosing it and getting explicit approval** (ideally an ADR, at minimum an explicit
yes). Silently adding one — or building on an inherited one without flagging it was
never ratified — is a serious architecture, product, AND security problem
(supply-chain/SBOM; PHI posture). **Flag undisclosed/un-ratified components for
review** rather than relying on them silently. The live audit is
`docs/governance/component-disclosure-review.md`.

Resolved (2026-07-04): the **TS/Hono runtime stack is ratified** by **ADR-0029** (supersedes the
Rejected ADR-0002), and **`@databricks/sql` is removed** (0 refs). Licensing (**ADR-0023**) and the
security infrastructure (**ADR-0031..0036**) are Accepted. Keep the disclosure audit current as new
deps are added.

## Storage topology (install-time choice)

The operator picks the storage topology at install: **single store** (everything off one
Delta store, operational + transactional — **the DEV default**) **or medallion**
(Bronze + Silver + Gold; the **operational/transactional store is Gold**, fed by
Bronze→Silver→Gold promotion). The **data governance, data quality, and promotion
criteria are out of RoninStandAlone scope — defined in another app**; RoninStandAlone
provides the topology + medallion plumbing only. Config: `RONIN_STORAGE_MODE =
single | medallion` (switch + medallion-Gold-read-path still to wire; dev uses single).
Detail: project memory `storage-topology`. (Ratifying ADR pending.)

## FHIR functionality scope & validation

The **compliance target is the full FHIR R4 server surface** — inventory + current
status in `docs/research/2026-06-28-core-fhir-functionality-inventory.md` (and the
validation-beyond-R4 + R4↔IG deep dive `…fhir-validation-beyond-r4-and-igs.md`). Today:
strong foundation (full R4 Core ingest + medallion + validate-prior-to-Bronze +
terminology `$validate-code`), light REST surface (gaps: rich search, history/vread,
operation surface, transactions, profile/IG validation, security-in-delta-app).

Validation layers: L1 structural + L2 cardinality (`fhir.resources`) → L3 terminology
bindings (local `$validate-code`) → L4 FHIRPath invariants (todo) → L5 profile/IG
conformance (todo; `PROFILE_VALIDATORS` hook). **All validation is PRIOR to Bronze;
invalid → dead-letter at the RESOURCE level, never bundle-level** (bundles are
decomposed first). Build order per memory `server-priorities`: full compliance →
profile/IG install → Inferno (not before profiles install).

## Conventions

- **ADR-driven decisions; no new ADR without Chad's go-ahead.** ADRs in
  `docs/decisions/` (numbered, never reused). RoninStandAlone diverges from the Ronin
  heritage starting at ADR-0022; heritage ADRs stay in force for Ronin.
- **Session logs** at `docs/status/session-NNN-YYYY-MM-DD.md`; `docs/status/latest.md`
  always points to the latest.
- **Secrets via 1Password `op run` only** — never read/print/store secret values.
- **Delivery is local-first**: get the OSS-Delta build working + pass Inferno
  locally before packaging (Docker = portable test artifact; OpenTofu/cloud last).

## Product (distinct from Ronin)

RoninStandAlone is the **open-source, no-Databricks** FHIR R4 server on OSS Delta
Lake (delta-rs writes/MERGE, DuckDB reads, TS clean-room flattener). Forked from
Ronin 2026-06-27. Drives FHIRmedic Consulting + paid open-core modules (Data Quality,
Data Governance). See `docs/standalone/product-definition.md` and the persistent
memory at the project's `memory/MEMORY.md`.
