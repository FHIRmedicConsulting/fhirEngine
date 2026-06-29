# ADR-0022: Standalone Storage — Clean-Room Columnar Flattening on OSS Delta, Layering B, and the Catalog/Governance Seam

- Status: **Accepted** 2026-06-27 (RoninStandAlone-specific; first divergence ADR from the Ronin heritage). Engine feasibility validated — see [feasibility review](../research/2026-06-27-standalone-engine-feasibility.md). The catalog/governance *binding* (§5) remains a deferred sub-decision (follow-up ADR); everything else is accepted.
- Date: 2026-06-27
- Decider(s): Chad
- Session: standalone fork (post session-031)
- Supersedes (for RoninStandAlone only): the dbignite/Databricks/DLT specifics of [ADR-0010](0010-storage-shape.md) §1 + Amendment 4, and the Unity-Catalog assumptions of [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md) / [ADR-0013](0013-deployment-posture.md). ADR-0010 stays in force for **Ronin** (the Databricks product).
- Related: [ADR-0010](0010-storage-shape.md), [ADR-0011](0011-write-contract.md), [ADR-0019](0019-storage-and-pipeline-operations.md), [docs/standalone/product-definition.md](../standalone/product-definition.md)

## Context

RoninStandAlone runs the FHIR R4 server + medallion lakehouse on **open-source Delta Lake with no Databricks** — no Unity Catalog, no SQL Warehouse, no DLT, no per-schema table quota. The inherited storage shape (ADR-0010) is realized on three Databricks-specific mechanisms that cannot ship in an OSS product:

1. **Flattening via dbignite.** ADR-0010 §1 + Amendment 4 store the resource body as dbignite's `from_json(body_json, <StructType>)` flattened columns, using **vendored dbignite r4 schemas** (`src/fhir-schema/dbignite/r4/*.json`). **dbignite is under the proprietary Databricks License** ("You may not use the Licensed Materials except in connection with your use of the Databricks Services"). The code *and the vendored schemas derived from it* are therefore unusable in a non-Databricks product. This is a hard licensing blocker, confirmed against the dbignite `LICENSE` and `setup.py` (`License :: Other/Proprietary License`).
2. **Spark SQL dialect.** `from_json`, `exists(arr, lambda)`, `NAMED_STRUCT`, `ARRAY<STRUCT>` literals, `MERGE INTO`, and the ~300 KB inline-literal ceiling on the `from_json` schema (which forced 5 resources to "store-only" and required metadata-stripping of every schema).
3. **Unity Catalog + DLT** for catalog/governance, lineage, classification, access policy, and the Bronze→Silver→Gold promotion pipelines.

We evaluated **SQL on FHIR v2 (ViewDefinition)** and rejected it *as the storage mechanism*: it is a vendor-neutral *view/projection contract* (FHIRPath-defined tabular views), and its reference runners target SQL engines (Postgres/DuckDB) at query time. That is not our canonical-storage need, and we are explicitly not running ViewDefinitions against Postgres. SQL-on-FHIR remains a candidate for a future **governed publication/view layer** on top of the medallion (see Follow-ups), not the flattener.

The chosen direction is a **blend of three columnar-storage patterns** adapted to OSS Delta.

## Decision

### 1. Flattening pattern — clean-room, schema-driven columnar (the blend)

Replace dbignite with a clean-room flattener that produces the same *ergonomic* (one Delta table per resource type, one column per FHIR element, `body_json` retained as source-of-truth) without any Databricks-licensed input. It blends three sources:

| Source | License | What we take |
|---|---|---|
| **dbignite** | Databricks-proprietary | Only the **table shape** — table-per-resource, one column per top-level FHIR element, `body_json` kept alongside. **No code, no schemas.** |
| **Parquet-on-FHIR** (aehrc) | CC0 | The **mapping conventions** — deterministic FHIR-element → columnar-type rules: choice types (`value[x]`), primitive + `_primitive` sibling extension pairs, references, nesting. Borrowed as a spec, not a dependency (it has no reference impl yet). |
| **Microsoft FHIR-to-Parquet** | MIT | The **depth/containment policy** — flatten to depth *N*, collapse deeper nesting + contained/Bundle resources to JSON strings. |

**The schema is generated clean-room from the HL7 FHIR R4 StructureDefinitions** (HL7-licensed, freely usable), not copied from dbignite. This generator replaces the vendored `src/fhir-schema/dbignite/` directory and the `${DBIGNITE_COLUMNS}` injection in `schema-apply.ts`.

The MSFT-style depth cap **eliminates the dbignite "store-only" cliff and the inline-literal ceiling**: every resource flattens to a useful degree (the deep tail stringified), and because `body_json` is retained, depth-capping is lossy *as columns* but never *as data*.

### 2. Flattening moves out of SQL and into TypeScript

On OSS Delta there is no Spark `from_json`. The flattener is a **TypeScript function**: parse the FHIR JSON body → emit a typed row matching the generated schema. The `Warehouse`/`DeltaWarehouse` layer writes those already-flat rows. This:

- removes the entire Spark-dialect porting problem for flattening (no `from_json`, no `NAMED_STRUCT`/`ARRAY<STRUCT>` literals, no literal-size ceiling);
- is the only viable shape anyway, because **delta-rs does no SQL flattening** (it writes Arrow row batches) and **DuckDB cannot enumerate STRUCT keys dynamically** and breaks on deep FHIR nesting.

### 3. OSS engine binding for `DeltaWarehouse`

- **Write + MERGE/upsert + soft-delete tombstone → delta-rs.** DuckDB's Delta writer is append-only (no MERGE as of 2026), which would break the Gold current-version upsert and the `deleted` tombstone from ADR-0010 §8. delta-rs supports `merge`.
- **Read / ad-hoc SQL → DuckDB** over the Delta tables.
- Flattening → TypeScript (§2).

This is the concrete `DeltaWarehouse` implementation of the existing `Warehouse` interface (`query`/`execute`/`close`). The FHIR/REST/repository layers are unchanged.

**Feasibility-validated realization** (see [feasibility review 2026-06-27](../research/2026-06-27-standalone-engine-feasibility.md)): there is **no usable Node binding for delta-rs**, so the writer runs as a **long-lived Python sidecar** wrapping the mature `deltalake` PyPI package (≥1.6.1, Apache-2.0; `DeltaTable.merge`), single-writer, Arrow-IPC handoff (napi-rs binding is the fallback if a Python runtime is unacceptable). Flatten/Arrow assembly uses `apache-arrow` JS v21. **Consequence:** RoninStandAlone sheds Spark/JVM but carries a Python runtime (lighter than Spark; Python was already the heritage bulk tier per ADR-0011). **Read engine: see Amendment 1 — single-engine delta-rs/DataFusion (DuckDB dropped).**

### 4. Medallion layering — Option B

RoninStandAlone diverges from ADR-0010's "flatten at Bronze" to a cleaner medallion:

- **Bronze — raw JSON landing.** Append-only, immutable audit of exactly what was received (`body_json` + operational columns + `identifier_index`). **No flattening at ingest** → fast, schema-agnostic writes; Bronze is a true raw landing/audit tier.
- **Silver — flattened + conformed + governed columnar.** The clean-room flattener (§1) runs **once at the Bronze→Silver boundary**. This is the clean, governed, enterprise-exposed analytics layer — "the power." Carries the governance/processing metadata already designed in ADR-0010 Amendment 3/4 (`silver_status`, `validation_state`, `audit_trail`, MPI output, etc.).
- **Gold — current-version transactional serving base.** Unchanged in spirit from ADR-0010: per-`fhir_id` current version via delta-rs MERGE, soft-delete, the read/serving projection for the FHIR REST API.

This supersedes ADR-0010 Amendment 4 change 1 ("Bronze resource tables ARE the dbignite flattened tables") **for RoninStandAlone**: here Bronze is raw, Silver is the flattened tier.

### 5. Catalog/Governance seam (replaces Unity Catalog + DLT)

Catalog, lineage, classification/tags, access policy, and data-quality metadata are abstracted behind a **`Catalog`/governance seam** (a second seam alongside `Warehouse`), so a deployment can bind to:

- **Cloud-native:** Microsoft Purview (Azure), BigLake / Dataplex (GCP).
- **OSS:** an Apache-stack catalog — Polaris, Gravitino, or Atlas.
- **None:** path-based Delta on a filesystem/object store (no catalog) for the simplest on-prem deployment.

The Bronze→Silver→Gold **promotion** (which on Ronin runs as DLT pipelines) becomes plain orchestrated code (TS worker and/or optional Python tier) reading Delta change data feed incrementally — **not** a Databricks pipeline. The specific catalog binding(s) and the promotion-orchestration shape are **deferred to follow-up ADRs** (they need their own research pass). This ADR establishes only that the seam exists and what it must abstract.

This seam is also where the commercial **Data Quality** and **Data Governance** modules attach (the OSS core ships the medallion + the seam; advanced DQ rule packs and catalog/governance integrations are the paid layer).

## Consequences

- The license blocker is removed: nothing Databricks-licensed ships. The clean-room generator + Parquet-on-FHIR (CC0) + MSFT (MIT) + HL7 R4 StructureDefinitions are all permissive / Apache-2.0-compatible (see the licensing ADR, queued).
- `src/fhir-schema/dbignite/` (vendored schemas) and the `${DBIGNITE_COLUMNS}` template path must be **excised** and replaced by the generator. Until then, the standalone build cannot legally ship.
- Two dbignite scars disappear: the 5 store-only resources flatten (depth-capped), and schema metadata-stripping is no longer needed (no SQL literal ceiling when flattening in TS).
- New dependency footprint: `delta-rs` (write/MERGE) + DuckDB (read). Node integration for delta-rs (native binding vs thin sidecar) is an implementation choice for the spike.
- Bronze no longer carries flattened columns (layering B); analytics consumers read Silver. Any heritage assumption that `SELECT birthDate FROM bronze.*` works no longer holds for RoninStandAlone.
- Change-data-feed-driven promotion without DLT is new operational surface; orchestration shape is a follow-up.

## Alternatives considered

- **SQL-on-FHIR v2 ViewDefinitions as the storage flattener.** Rejected — it's a query/view contract, not canonical storage; runners target Postgres/DuckDB at query time; one ViewDefinition per output table, lossy by design. Retained as a candidate for a future governed *view* layer, not storage.
- **Keep dbignite schemas/code.** Rejected — proprietary Databricks License; not usable off-Databricks.
- **Pathling / google fhir-data-pipes as the flattener.** Rejected — Apache-licensed but require Spark/Beam (JVM), the exact stack RoninStandAlone sheds; no TS binding.
- **MSFT FhirToDataLake schema generator directly.** Rejected as primary — lossy by default (depth>3 → strings), C#/.NET, Azure-packaged. Its *depth-cap policy* is borrowed; its implementation is not.
- **Flatten at Bronze (ADR-0010 layout A).** Rejected for RoninStandAlone — couples ingest speed to flattening and makes Bronze less of a true raw landing; Option B matches the "governed Silver to the enterprise" goal.
- **DuckDB as the writer.** Rejected — append-only Delta write (no MERGE) breaks Gold upsert + soft-delete. DuckDB is the read engine; delta-rs is the writer.

## Follow-up ADRs queued

- **Open-source licensing ADR** — core Apache-2.0 + open-core proprietary-module model + AI-authorship/CLA hygiene (research complete; draft pending).
- **Catalog/governance binding ADR** — choose first-class bindings (Purview / BigLake-Dataplex / Apache Polaris/Gravitino/Atlas / none) and the abstraction contract.
- **Medallion promotion orchestration ADR** — Bronze→Silver→Gold via Delta CDF without DLT (TS worker vs optional Python tier; cadence; idempotent replay).
- **Clean-room R4 schema generator spec** — the deterministic StructureDefinition → columnar-schema rules (depth cap *N*, choice types, `_primitive` siblings, references, containment), with Parquet-on-FHIR conventions cited.
- **Governed view layer (SQL-on-FHIR v2)** — optional published ViewDefinition contracts over Silver/Gold for enterprise consumers.

## Open questions not closed by this ADR

- ~~delta-rs Node integration shape (native N-API binding vs Python sidecar)~~ **Resolved 2026-06-27** (feasibility review): Python sidecar wrapping `deltalake` PyPI, single-writer; napi-rs fallback. Write throughput vs interactive latency targets still needs a measured spike (MERGE is scan-heavy without partition/Z-order pruning).
- Depth cap *N* — the value that balances column usefulness vs table width across the 146 R4 base types.
- Whether Gold also benefits from selective flattened columns (today Gold is `body_json` + denorm; ADR-0010 A4 change 2 keeps Gold un-flattened to avoid name/type collisions — revisit per consumer need).
- Catalog seam contract surface (registration, lineage, classification, policy, DQ metadata) — defined in the binding ADR.

---

## Amendment 1 — Single engine: delta-rs / DataFusion for read+write; DuckDB dropped (2026-06-27, session 032)

§3 originally split the engine binding into **delta-rs for writes** and **DuckDB for
reads**. Chad's call: don't carry a second engine, and don't let an analytical
query-engine choice gate a working server. This amendment makes the engine
**single**.

### Decision

- **delta-rs / Apache DataFusion is the single engine for both write and read.**
  delta-rs is built on DataFusion (a SQL engine); it both manages Delta (write,
  MERGE, soft-delete, CDF) and serves the read/query SQL. **DuckDB is dropped** from
  the standalone plan.
- **Why DuckDB is dropped:** it was an *inherited assumption* from
  `docs/standalone/product-definition.md`, validated as "works" in the POC but never
  chosen as the best option. Its main DuckDB-specific edge — reading Delta
  **deletion vectors** that delta-rs's reader doesn't — **does not apply**, because
  soft-delete here is a `deleted` boolean tombstone column (ADR-0010 §8), not
  deletion vectors. Fewest engines wins for a portable, self-hostable product.
- **Sequence / scope:** the priority is a **working FHIR server writing data** on
  delta-rs/DataFusion (Layering B) **before** picking or optimizing any
  query/data-management platform. The definitive analytical query/management-platform
  selection is **out of RoninStandAlone's scope** ("we'll get there, but not through
  RoninStandAlone"). The engine choice stays **reversible behind the `Warehouse`
  seam** — DuckDB/Polars/etc. can be revisited later if a concrete need forces it.

### Consequences

- `DeltaWarehouse` is realized over delta-rs/DataFusion only; no `@duckdb/node-api`
  dependency. The POC's `read-duckdb.ts` remains a historical interop artifact, not
  the chosen path.
- The Spark→engine read-dialect port targets **DataFusion SQL** via delta-rs's
  embedded `QueryBuilder` (verified session 032: reads delta-rs tables; point read +
  scan work directly). The Spark `exists(identifier, i -> i.system=? AND i.value=?)`
  nested search ports to a **DataFusion unnest-subquery** (NOT a lambda):
  `SELECT DISTINCT id FROM (SELECT id, unnest(identifier) AS i FROM t) WHERE i.system=? AND i.value=?`
  (`get_field`/dot/bracket struct access all work). delta-rs `QueryBuilder` results are
  arro3 Tables → bridge to pyarrow via the Arrow C-stream interface.
- ADR-0025/0026/0027 references to DuckDB as the reader are superseded by this
  amendment.

### Status

**Accepted.** Supersedes §3's DuckDB read-engine choice. All other §3 decisions
(delta-rs writer via Python sidecar, TS flattener, apache-arrow) stand.
