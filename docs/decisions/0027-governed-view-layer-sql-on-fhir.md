# ADR-0027: Governed View Layer — SQL-on-FHIR v2 ViewDefinitions (Future / Optional)

- Status: **Proposed** (future / demand-gated; not in the first standalone slice). RoninStandAlone-specific.
- Date: 2026-06-27
- Decider(s): Chad
- Session: 032 (standalone fork)
- Related: [ADR-0022](0022-standalone-storage-flattening-and-catalog-seam.md) (SoF rejected *as storage*; retained as a view layer here), [ADR-0024](0024-clean-room-r4-columnar-schema-generator.md), [ADR-0023](0023-open-source-licensing-and-open-core-model.md)

## Context

ADR-0022 evaluated **SQL on FHIR v2 (HL7 ViewDefinition)** and rejected it **as the
storage/flattening mechanism** — it is a *view/projection contract* (FHIRPath-
defined tabular views), not canonical columnar storage, and its reference runners
target SQL engines at query time. The clean-room flattener (ADR-0024) owns
canonical Silver storage.

But SoF v2 is exactly the right tool for the **other** job: publishing **governed,
versioned, vendor-neutral tabular views/marts** to enterprise analytics consumers
on top of the medallion. This ADR records that intent and the chosen approach,
deferred until there is consumer demand.

## Decision (when built)

1. **SoF v2 ViewDefinitions are the governed publication layer** over Silver/Gold —
   each ViewDefinition is a named, versioned governance artifact (FHIRPath columns,
   filters, `forEach` unnesting) defining a tabular contract for a consumer
   (e.g. `patient_demographics`, `coverage_active`, quality-measure inputs).
2. **Pure-TS runner**, modeled on the HL7 JS reference impl (`sof-js`), using the
   **`fhirpath`** npm package (BSD) for evaluation — no Spark, no Postgres, no JVM
   (consistent with the standalone stack). The SoF v2 spec itself is **CC0**.
3. **Materialization**: views run over the Silver columnar tables (or `body_json`
   via FHIRPath) and materialize to Delta tables (delta-rs) or are exposed as engine
   (delta-rs/DataFusion) views — read-only, downstream of Gold/Silver, never on the
   write path.
4. This layer is a natural home for the commercial **Data Governance / Data Quality
   modules** (ADR-0023): the OSS core can ship a basic runner; curated view packs,
   lineage, and governance tooling are candidate paid surfaces.

## Why deferred

- No standalone consumer needs it yet; the first slice is the FHIR REST surface on
  `DeltaWarehouse` + local Inferno (ADR-0022 follow-ups).
- SoF v2 is still STU-track (v2.0.0 published, v2.1.0-pre in CI) — fine to adopt,
  but no urgency to commit the runner before a consumer drives the view set.

## Consequences

- Clean separation of concerns: **ADR-0024 = canonical storage flattening**;
  **this ADR = consumer-facing governed views**. Don't conflate them.
- All dependencies permissive (SoF spec CC0, `fhirpath` BSD) — Apache-2.0-compatible
  per ADR-0023.

## Open questions

- Trigger to build: which enterprise consumer / module first justifies it.
- Materialized-Delta vs on-the-fly engine views (freshness vs cost) — decide per
  consumer when built.
