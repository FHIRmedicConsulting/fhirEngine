# Terminology services & provisioning-time loading — RoninStandAlone (design)

Fleshes out the standalone terminology service + **how terminologies, value sets,
concept maps, and profiles get loaded at provisioning**. Adapts the heritage
**[ADR-0017](../decisions/0017-terminology-service.md)** (Databricks) to the OSS-Delta
stack (delta-rs write / DataFusion read; pure-local; no external tx server). Unifies
with the profile/IG install facility — **IG packages carry both StructureDefinitions
(profiles) AND ValueSets/CodeSystems/ConceptMaps (terminology)**, so they load together.
Supports the [[server-priorities]]: #1 full FHIR compliance (needs bindings →
terminology), #2 profile/IG install, then #3 conformance testing.

## 1. Anchor stack (what's authoritative)
Three layers (per ADR-0017 §1): **FHIR R4 Core** (base CodeSystems/ValueSets) +
**HL7 Terminology (THO)** + **IG terminologies** (US Core, CARIN BB, …). All resolved
**locally** from the Delta-backed store — no calls to tx.fhir.org / external servers.

## 2. Sources: bundled-redistributable vs operator-licensed

| Source | Content | Redistribute? | Load at provision |
|---|---|---|---|
| `hl7.fhir.r4.core` | R4 base CS/VS (2,378 in cache) | yes (HL7) | bundled |
| `hl7.terminology` (THO) | HL7 CodeSystems/ValueSets | yes (HL7) | bundled |
| IG packages (US Core, CARIN BB) | profile + IG VS/CS | yes | on IG install |
| NLM **VSAC** / CDC **PHINVADS** | value-set *definitions* | defs yes (codes licensed) | bundled defs; codes need license |
| **SNOMED CT, LOINC, RxNorm, ICD, CPT, UCUM** | large licensed code systems | **NO** | **operator-supplied** (under their license) |

Rule: **never redistribute licensed content.** Bundled-redistributable terminology
loads automatically at provisioning; licensed code systems are operator-loaded from
release files the operator legally holds.

## 3. Storage — six Delta tables (adapted from ADR-0017 §4), `terminology` tier
delta-rs-written, DataFusion-read, under the catalog `terminology` tier (path-based or
UC, per ADR-0025):
- `codesystem_header` — one row per loaded CodeSystem version (url, version, content, count).
- `codesystem_concept` — one row per concept (code, display, designations).
- `codesystem_property` — hierarchy/parts (SNOMED is-a, LOINC parts).
- `valueset_definition` — one row per ValueSet version (compose rules).
- `valueset_expansion` — **pre-materialized** expansion rows (fast `$expand`/`$validate-code`).
- `conceptmap` — bidirectional translation rows (`$translate`).

## 4. Provisioning loader (the load-the-terminologies-at-provision mechanism)

A single **conformance-resource loader** runs at provision/install time and on demand:

1. **IG package ingest** (the unified profile+terminology install). Given a FHIR npm
   package (e.g. `hl7.fhir.us.core#6.1.0` from the `~/.fhir` cache or an uploaded
   tarball), walk its resources:
   - `StructureDefinition` → profile registry (validation; feeds the sidecar
     `PROFILE_VALIDATORS`) + CapabilityStatement.
   - `CodeSystem` / `ValueSet` / `ConceptMap` → the six terminology tables.
2. **Bundled baseline** at first provision: load R4 Core + THO (redistributable).
3. **Operator-licensed loaders**: separate ingest commands for SNOMED/LOINC/RxNorm
   release files the operator supplies (NLM/UMLS distribution formats → `codesystem_*`
   tables). Gated on the operator asserting their license.
4. **Pre-expansion at load**: expand `compose`-based ValueSets into
   `valueset_expansion` (skip/limit grammar-only or intensional SNOMED expansions per
   policy). Makes `$validate-code`/`$expand` a single Delta point-read.
5. **Idempotent + versioned**: re-runnable; writes a new version, flips the active pin
   (§7). Same `delta-rs` single-writer + dead-letter discipline as ingestion.

Operator surface: `ronin install-ig <pkg>` / `ronin load-terminology <source>` (CLI),
and/or an authenticated admin endpoint. Self-hosted: runs in the deploy container;
licensed sources mounted/provided by the operator.

## 5. Terminology operations — pure-local, DataFusion
v1 surface (ADR-0017 §2): **`$validate-code`**, **`$lookup`**, **`$expand`**,
**`$translate`** — answered by DataFusion queries over the six tables (point reads /
expansion scans), with an in-process LRU cache for hot codes/value sets (replaces the
Databricks Apps LRU + warehouse warm pool of ADR-0017 §8). No external tx server.

## 6. Wiring to validation + profiles (the full-compliance path)
- **Structural validation** (now): `fhir.resources` at ingest (R4 Core), dead-letter on
  fail ([[validation-before-bronze]]).
- **Binding validation** (this enables): profile/element value-set bindings checked via
  local `$validate-code` against loaded expansions — the deeper layer toward **full FHIR
  compliance** and **US Core** conformance.
- **Profile validation**: installed profiles' constraints (cardinality/must-support/
  bindings) run via the `PROFILE_VALIDATORS` registry for resources claiming them.
Layering matches ADR-0015: structural → binding/terminology → profile.

## 7. Versioning & refresh (operator-pulled)
A `terminology_artifacts` active-version **pin** table (ADR-0017 §6): loads stage a new
version; an operator flip activates it (atomic, auditable). Refresh is **operator-
pulled** (no silent auto-update) — re-run the loader for a new THO/IG/SNOMED release,
then flip. Binding pins recorded for read-time version recovery (ADR-0017 §5).

## 8. Licensing (hard rule)
Redistributable (R4 Core, THO, IG VS/CS, VSAC/PHINVADS *definitions*) ship/auto-load.
**SNOMED/LOINC/RxNorm/ICD/CPT/UCUM are operator-supplied** — never bundled, never
redistributed; loaded by the operator under their own license. Ties to
[[phi-security-standards]] (and the Apache-2.0 product license, [ADR-0023]).

## 9. Standalone deltas vs heritage ADR-0017
- Storage: same six-table model, on **delta-rs/DataFusion** (not Databricks SQL).
- Hot path: **in-process LRU** (not Apps LRU + SQL warehouse warm pool).
- Provisioning: **container/CLI loader** from IG packages + operator sources (not a
  Databricks job). Pure-local resolution preserved (already the standalone ideal).

## Implementation status (session 032)

- **Storage follows the topology** (Chad, session 032): provisioning data (terminology +
  conformance) lands per `RONIN_STORAGE_MODE` — **single** = directly under the one store;
  **medallion** = under `gold/` (**Gold-only**, no Bronze raw landing). `PathCatalog`
  takes a `StorageMode`; `DeltaWarehouse` resolves it (default single). See
  [[storage-topology]].
- **Operator-supplied file loaders DONE** (`src/terminology/file-loaders.ts`): **LOINC**
  (CSV), **SNOMED CT** (RF2 snapshot; active concepts, active-FSN display map), **RxNorm**
  (RRF; SAB=RXNORM English atoms). Streamed + batched (20k/batch) → `codesystem_concept` +
  `codesystem_header`. `display` always non-null (falls back to code) for stable Delta
  column type. Verified against the real release files (`limit` slices) + `$validate-code`.
- **Provisioning CLI** (`scripts/ronin-terminology.ts`): `load-terminology
  <loinc|snomed|rxnorm> <dir> [--limit N] [--no-descriptions]` and `install-ig <dir> [id]`.
  Command logic in shared modules so a future authenticated admin endpoint reuses the core
  (CLI now, endpoint later). Run under `op run` for API keys.
- **Licensing safety**: `terminologies/` (+ `*.RRF`, `sct2_*`, `der2_*`) **gitignored** —
  never committed/redistributed (operator's own license).

## Configurable update process (NLM/UMLS) — DONE (operator-picks)

The update process is **operator-configurable** (`src/terminology/updater.ts`, config selects
sources/modes; nothing auto-updates — operator-pulled per §7):
- **VSAC `ValueSet/$expand`** (`sources/vsac.ts`) → `valueset_expansion` for value sets whose
  codes are licensed. Auth: Basic `apikey:<UMLS_API_KEY>`. Key ref **`op://Ronin/UMLSAPI/
  password`** → `deploy/.env.op` (`UMLS_API_KEY`); run via `op run --env-file=deploy/.env.op`.
  The key is **never read/logged/stored** — the auth header is built in-memory and errors
  never include it (unit-tested).
- **RxNav** (`sources/rxnav.ts`) — RxNorm version check + lookup (public, no key).
- **Version report** — `check-updates` lists loaded CodeSystem versions from `codesystem_header`.
- CLI: `expand-vsac <oid…>`, `check-updates`, `update <config.json>`.

## Remaining
1. `$expand`/`$lookup`/`$translate` ops surface (beyond `$validate-code`).
2. `codesystem_property` (hierarchy) + idempotent versioned loads + the active-version pin.
3. SNOMED/LOINC release-version checks (RxNorm done via RxNav; SNOMED needs the syndication
   feed, LOINC has no simple version API).
4. Admin HTTP endpoint reusing the loader core (after the security port).
5. Ratify as a **standalone terminology + provisioning ADR** (adapts ADR-0017) — needs go-ahead.
