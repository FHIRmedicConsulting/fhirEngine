# ADR-0024: Clean-Room R4 Columnar Schema Generator — Mapping Spec

- Status: **Accepted** 2026-06-27 (POC-validated across all 146 R4 resource types). RoninStandAlone-specific.
- Date: 2026-06-27
- Decider(s): Chad
- Session: 032 (standalone fork)
- Related: [ADR-0022](0022-standalone-storage-flattening-and-catalog-seam.md) (parent), [ADR-0023](0023-open-source-licensing-and-open-core-model.md), [feasibility review](../research/2026-06-27-standalone-engine-feasibility.md), POC: `poc/delta-flatten-poc/`

## Context

ADR-0022 replaces dbignite (proprietary Databricks license) with a **clean-room**
columnar flattener generated from the **HL7 FHIR R4 StructureDefinitions (CC0)**.
This ADR pins the deterministic mapping rules — the contract the generator and the
Silver-tier table schemas must agree on. The rules were implemented and proven in
the POC (`poc/delta-flatten-poc/src/flatten.ts`): **146/146 concrete R4 resource
types generate cleanly; 1,119 real instances (Synthea bundles + R4 examples, 140
types) flatten + round-trip with zero failures.**

The blend (ADR-0022 §1): dbignite *shape* + Parquet-on-FHIR *conventions* (CC0) +
Microsoft FHIR-to-Parquet *depth-cap policy* (MIT). Source of truth for types is
each resource's `snapshot.element[]` (fully resolved — no differential/profile
resolution needed for base resources).

## Decision — mapping rules

### 1. Table shape
One columnar table per resource type. Top-level columns = the resource's top-level
FHIR elements. `id` is the key column; **`body_json` (the exact resource) is
retained as source-of-truth** alongside the flattened columns (dbignite principle).
Flattening is lossy *as columns* (depth cap, §6) but never *as data*.

### 2. Primitive → Arrow type
FHIR primitives map to fixed Arrow types:
- `boolean` → bool; `integer`/`positiveInt`/`unsignedInt` → int32; `decimal` → float64;
- all textual primitives (`string`, `code`, `uri`, `url`, `canonical`, `oid`, `uuid`,
  `id`, `markdown`, `base64Binary`, `date`, `dateTime`, `instant`, `time`, `xhtml`,
  and `http://hl7.org/fhirpath/System.String`) → utf8.
Dates/times are kept as utf8 (FHIR partial-date semantics; no lossy date coercion).

### 3. Cardinality → list
`max = "*"` (or numeric > 1) → the column is a `list<…>`; otherwise scalar.

### 4. Choice types (`value[x]`)
Expanded to **one column per type**: `deceased[x]` → `deceasedBoolean` (bool) +
`deceasedDateTime` (utf8); `multipleBirth[x]` → `multipleBirthBoolean` +
`multipleBirthInteger`. Column names match FHIR JSON property names exactly, so the
flattener reads them directly.

### 5. Complex datatypes & backbone elements → struct
- **Named complex datatype** (Identifier, HumanName, CodeableConcept, Period,
  Reference, …): recurse into that type's own StructureDefinition → `struct<…>`.
- **Backbone element** (children defined inline in the resource snapshot, e.g.
  `Patient.contact.relationship`): recurse within the same element list by path
  prefix → `struct<…>`.
- **`contentReference`** (recursive backbone, e.g. `Questionnaire.item.item` →
  `#Questionnaire.item`): resolve to the referenced path and recurse; the depth cap
  bounds the recursion.

### 6. Depth cap (MSFT-style) — default N = 3
Struct recursion materializes to **MAX_DEPTH levels**; deeper nesting collapses to
a single JSON-string column. This also bounds complex-type cycles (Reference →
Identifier → Reference). It eliminates dbignite's two scars: there are **no
"store-only" resources** (everything flattens to a useful degree) and **no
inline-`from_json` literal-size ceiling** (flattening happens in TS, not SQL). N is
a tunable starting value; revisit across resource widths.

### 7. Primitive extension siblings (`_field`)
Each primitive column gets an optional `_<name>` sibling column (JSON) for the FHIR
primitive-extension pattern (`id`/`extension` on a primitive). Preserved, not
dropped.

### 8. Always-stringify open/recursive types
`Resource` (e.g. `contained`), `Extension`, and `Narrative` collapse to JSON-string
columns regardless of depth — open/recursive and not usefully columnar. Their data
survives in `body_json`.

### 9. Skipped root infrastructure (kept in body_json)
`id` (promoted to key), `meta`, `implicitRules`, `language`, `text`, `contained`,
`extension`, `modifierExtension` are not emitted as data columns at the resource
root; they remain in `body_json`. (Operational columns — `version_id`,
`last_updated`, `deleted`, etc. — are added by the storage layer per ADR-0010/0022,
not by the generator.)

## Consequences

- The generator is a few-hundred-LOC pure-TS module with no runtime FHIR/Databricks
  dependency; its only input is the CC0 R4 StructureDefinition package.
- The same generated schema drives both the **Arrow schema** handed to the delta-rs
  writer and the **Silver-tier table definition** — one source of truth, no drift.
- Schemas are wide (Patient = 21 data columns; nested structs expand further).
  Acceptable; `body_json` is the compact source-of-truth and the read path can
  project only needed columns.
- 6 resource types (`Parameters`, 5 `Substance*`) have no test instances anywhere;
  their schemas generate but are unexercised against real data.

## Follow-ups

- **Golden-file fixtures** per resource type (expected column set) to catch silent
  schema drift; the breadth test currently asserts no-throw + `body_json`
  round-trip only.
- **Tune MAX_DEPTH** with real query patterns (which nested fields analysts need as
  columns vs. JSON).
- **R5/R6 climb**: the generator is version-agnostic (point it at the R5/R6
  StructureDefinition package) — supports the IG-version ratchet (ADR-0014).
- **Generate the Silver DDL** from the generator output (replaces the heritage
  `${DBIGNITE_COLUMNS}` injection in `schema-apply.ts`).
