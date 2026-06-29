# RoninStandAlone — product definition

**RoninStandAlone is a distinct product** forked from Ronin (2026-06-27). Same FHIR
R4 server + medallion-lakehouse architecture, but it **runs on open-source Delta
Lake with no Databricks dependency** — self-hostable, portable, no Unity Catalog,
no SQL Warehouse, no per-schema table quota, no cloud lock-in or per-DBU cost.

| | Ronin (origin) | RoninStandAlone |
|---|---|---|
| Storage engine | Databricks Delta + Unity Catalog | **Open-source Delta Lake** (filesystem / object store) |
| Query/compute | Databricks SQL Warehouse (Spark) | Embeddable OSS engine (see below) |
| Catalog | Unity Catalog (100-table quota on Free Edition) | OSS catalog / path-based Delta (no table quota) |
| Connector | `@databricks/sql` | OSS Delta + SQL engine driver |
| Flattening | dbignite (`from_json`) on Databricks Spark | **clean-room columnar flattener** (TS), schemas generated from HL7 R4 StructureDefinitions — see ADR-0022 |
| Catalog/governance | Unity Catalog + DLT | **pluggable Catalog seam** — Purview / BigLake-Dataplex / Apache Polaris-Gravitino-Atlas / none (path-based) |
| Deploy | Databricks Apps | any container / host (it's a Hono/Node server) |
| Auth, SMART, MPI, FHIR logic | shared | **shared, unchanged** (cloud-agnostic) |

## Why this is a clean fork, not a rewrite
The codebase already abstracts storage behind a **`Warehouse` interface**
(`packages/ronin-server-ts/src/lib/warehouse.ts`) with two implementations today:
`InMemoryWarehouse` and `DatabricksWarehouse`. The FHIR/REST/repository layers
depend only on the interface. So "no Databricks" = **add a third implementation,
`DeltaWarehouse` (OSS)** — the seam already exists.

What already helps:
- The **`Warehouse` abstraction** isolates all storage SQL.
- **`InMemoryWarehouse`** already proves the server runs with zero Databricks (393 tests pass on it).
- FHIR validation, SMART/OAuth, MPI, `$member-match`/`$everything`, soft-delete, generic write path — all cloud-agnostic, carried over verbatim.

> ⚠️ **dbignite must be excised, not reused.** dbignite ships under the **proprietary Databricks License** — the code *and* the vendored schemas at `src/fhir-schema/dbignite/r4/*.json` cannot ship in this OSS product. Flattening is replaced by a **clean-room columnar flattener** generated from HL7 R4 StructureDefinitions, blending the table shape (dbignite), mapping conventions (Parquet-on-FHIR, CC0), and depth/containment policy (Microsoft FHIR-to-Parquet, MIT). See **[ADR-0022](../decisions/0022-standalone-storage-flattening-and-catalog-seam.md)**. (SQL-on-FHIR v2 ViewDefinitions were evaluated and rejected as the *storage* mechanism — they are a query/view contract, not canonical flattening; retained as a possible future governed view layer.)

## The work to make it standalone (roadmap)

> **Decisions now made in [ADR-0022](../decisions/0022-standalone-storage-flattening-and-catalog-seam.md) (+ Amendment 1):** engine = **single delta-rs / DataFusion for both write+MERGE and read** + TS flattener (**DuckDB dropped** — was an inherited assumption, not a decision); medallion = **Layering B** (Bronze = raw JSON landing, Silver = flattened + governed columnar exposed to the enterprise, Gold = current-version transactional serving); a **pluggable Catalog/governance seam** replaces Unity Catalog + DLT. Priority is a **working server writing data first**; the analytical query/management-platform choice is out of RoninStandAlone scope. The options below are kept as the historical evaluation record.

1. **Pick the OSS engine** (the one real decision — see options below).
2. **`DeltaWarehouse`** implementing `Warehouse` (`query`/`execute`) against OSS Delta.
3. **Port the SQL dialect** — the Databricks/Spark-isms in the repo + `schema-apply`:
   `from_json(body, <schema>)`, `exists(arr, lambda)`, `NAMED_STRUCT`, `ARRAY<STRUCT>`
   literals, `MERGE INTO`, `DESCRIBE`/`SHOW TABLES`, `information_schema`. Map each to
   the chosen engine. (The `InMemoryWarehouse` matcher set is a good inventory of the
   exact queries to port.)
4. **Catalog/DDL** — replace Unity Catalog catalog/schema creation + `${DBIGNITE_COLUMNS}`
   table generation with OSS-Delta table creation (path- or metastore-based). The
   146-table whole-R4-base design is unconstrained here (no UC quota — the very limit
   that forced Ronin's GCP migration does not exist in OSS Delta).
5. **MERGE / upsert** — Gold current-version MERGE needs an engine with Delta MERGE
   (delta-rs and Spark have it; DuckDB's Delta write/MERGE is the thing to verify).
6. **Deploy** — drop the Databricks Apps assumptions; ship as a container.

## OSS engine options (decision pending — Chad)
- **delta-rs (`deltalake`, Rust/Python)** — read+write+MERGE Delta without Spark.
  Lightweight; Node integration via a binding or a thin Python sidecar. Strong for writes.
- **DuckDB + `delta` extension** — excellent embeddable SQL (has `from_json`, STRUCT,
  lists), reads Delta well; **Delta *write*/MERGE support is newer — verify** before
  committing. Could pair DuckDB (reads/SQL) + delta-rs (writes).
- **Apache Spark + `delta-spark`** — full Delta + Spark SQL (closest dialect match to
  Ronin, least porting), but heavy (JVM/cluster) — least "standalone."
- **Delta Standalone (JVM)** — Delta read/write without Spark; JVM dependency.

**Recommendation to evaluate first:** DuckDB (SQL/read layer) + delta-rs (write/MERGE),
for the smallest standalone footprint — *pending* a spike to confirm Delta MERGE +
`from_json` flattening cover the repo's query set. If porting cost is too high, Spark
+ delta-spark is the lowest-divergence fallback.

## Relationship to Ronin
Shared heritage: the ADRs, requirements, and architecture docs were forked verbatim
and apply to both initially. They will **diverge** — RoninStandAlone-specific decisions
get their own ADRs here. Ronin stays the Databricks-optimized product; RoninStandAlone
is the portable OSS-Delta product. (Code identifiers like `@ronin/*` package names are
unchanged for now; rename is optional future cleanup.)

## Status
**Forked 2026-06-27.** Code + all architectural/requirement docs + memory copied. The
OSS-Delta backend is **not yet built** — this document defines the product and its
direction. Next step when prioritized: choose the OSS engine, then implement
`DeltaWarehouse` + port the dialect.
