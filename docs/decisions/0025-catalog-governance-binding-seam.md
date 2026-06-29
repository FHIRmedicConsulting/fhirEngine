# ADR-0025: Catalog / Governance Binding Seam

- Status: **Proposed** (research-validated; resolves the deferred catalog sub-decision of ADR-0022 §5). RoninStandAlone-specific.
- Date: 2026-06-27
- Decider(s): Chad
- Session: 032 (standalone fork)
- Supersedes (for RoninStandAlone): the **Unity Catalog (Databricks-managed)** assumption of [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md) / the catalog choice collapsed into it. ADR-0009 stays in force for Ronin.
- Related: [ADR-0022](0022-standalone-storage-flattening-and-catalog-seam.md) (parent; §5 deferred this), [ADR-0026](0026-medallion-promotion-orchestration.md), [ADR-0023](0023-open-source-licensing-and-open-core-model.md)

## Context

ADR-0022 §5 established that catalog/governance (table registration, lineage,
classification/tags, access policy, DQ metadata) is a **pluggable seam** alongside
`Warehouse`, replacing Unity Catalog + DLT — but deferred the binding choice. This
ADR makes it. Research-verified June 2026 against primary sources; the data store is
**OSS Delta** (single-engine **delta-rs / DataFusion** for read+write per ADR-0022
Amendment 1; no Databricks/Spark/DuckDB). (DuckDB mentions below are ecosystem context
for catalog support, not our engine.)

Decisive finding: **most "OSS catalogs" are Iceberg-first and treat Delta as
pointer-only metadata with no commit coordination** (Polaris generic-tables beta:
*"no commit coordination provided by Polaris … the responsibility of the engine"*;
Gravitino: external-register metadata only — no Alter/Purge/data-serving). The one
exception is **Unity Catalog OSS** (Apache-2.0, LF AI & Data), which is **Delta-
native** and ships first-class **delta-rs** (`deltalake-catalog-unity` crate) and
**DuckDB** (`unity_catalog` extension) clients with REST + credential vending.

## Decision

### 1. The seam exists; bindings are pluggable and capability-gated
A `Catalog` interface abstracts catalog/governance. Bindings advertise capabilities;
unsupported capabilities **no-op gracefully** (essential — path-based has no
governance; UC OSS has RBAC but no tags/lineage). The FHIR/storage layers depend
only on the interface.

### 2. Default (local / on-prem): path-based / no catalog
delta-rs/DataFusion reads and writes Delta by filesystem/object-store **path**.
**No extra service.** Governance at this tier = object-store IAM
(prefix-granular) + SSE/KMS encryption + access logs. This is genuinely sufficient
for single-tenant, single-writer on-prem and is the local-first floor (matches the
[[dev-deployment-strategy]] local-first goal). Delta commit atomicity is provided by
the storage itself (filesystem rename; conditional-put on object stores); combined
with our single-writer-per-table model (ADR-0026) no external commit-coordination
service is needed.

### 3. First OSS catalog binding: Unity Catalog OSS
The first real catalog binding is **Unity Catalog OSS** (Apache-2.0, self-hostable,
pre-1.0 / server v0.5.0): Delta-native, REST (OpenAPI) + Hive-metastore-compatible +
read-only Iceberg-REST façade, credential vending; works with delta-rs
(`deltalake-catalog-unity` v0.16.x) and DuckDB (`unity_catalog` ext, non-experimental
since May 2026, INSERT + time travel; DDL via UC CLI). Governance in OSS = GRANT/
privilege **RBAC + IdP auth only** — **no tags/lineage** (those are Databricks-
managed); cover tags/lineage via a governance adapter (§4) when needed.

### 4. Cloud governance adapters (thin, open-wire): Purview first, then Dataplex/BigLake
For enterprises that mandate a cloud governance plane, bind via **open wire formats**
so adapters stay thin:
- **Microsoft Purview** (first — Azure dominance + HIPAA/BAA in healthcare): Atlas
  2.2-compatible REST Data Map; Delta scanned as a Parquet resource set. SaaS, no
  self-host → governance *adapter*, not a storage backend.
- **Google Dataplex + BigLake** (secondary): BigLake reads Delta external tables
  (read-only, GCS); Dataplex gives lineage, Auto DQ, policy tags. SaaS adapter.
- **Apache Atlas**: only to push lineage/classifications into an *existing* enterprise
  Atlas+Ranger estate via REST — never self-hosted here (JanusGraph+HBase+Solr+Kafka
  is anti-portable).
- **Apache Gravitino**: consider only if multi-format federation + strong OSS
  governance (OpenLineage lineage, tags, policy) becomes a real requirement; Delta is
  external-metadata-only, so it governs/discovers but does not manage Delta tables.
- **Apache Polaris**: Iceberg-first; Delta only via beta pointer "generic tables" with
  no commit coordination — not a Delta catalog for our purposes.

### 5. Abstraction contract (the `Catalog` interface)
Narrowest superset that path-based, UC OSS, and cloud adapters can all satisfy.

**Core (required by all):**
- `listNamespaces` / `createNamespace` / `dropNamespace`
- `listTables(namespace)`
- `resolveTable(name) -> { storageLocation (URI), format: "delta", schema }` — the
  load-bearing op (logical name → path + schema for delta-rs/DataFusion)
- `registerTable(name, location, schema)` / `dropTable(name, { purgeData })`
- `getSchema` / `updateSchema`

**Credentials (no-op for path-based; vended by UC OSS/cloud):**
- `getTableCredentials(name) -> short-lived storage creds`

**Optional, capability-gated (degrade gracefully):**
- `policy`: `grant/revoke(principal, securable, privilege)` (UC OSS yes; path-based defers to object-store IAM)
- `tags`: `setTags/getTags`, `setClassification` (Gravitino/Purview/Dataplex)
- `lineage`: `emitLineage/getLineage` — **OpenLineage** event shape (portable across Gravitino/Dataplex/Atlas/Purview)
- `dataQuality`: `setQualityMetadata/getQualityMetadata`

**Design rules:** only `resolveTable` + `registerTable` (+ namespaces/schema) are
mandatory, so the path-based default is a trivial legal implementation. Adopt open
wire shapes at the seam — **OpenLineage** (lineage), **Atlas 2.2 REST** (→ Purview),
**Iceberg REST** (interop denominator; UC OSS already exposes a read-only IRC façade).
The `dataQuality`/`tags`/`lineage`/`policy` capabilities are the attach surface for
the commercial **Data Governance / Data Quality modules** (ADR-0023).

### 6. First two bindings to ship
`NoCatalog` (path-based, default) and `UnityCatalogOSS`. They prove the seam against
the two extremes (no governance vs Delta-native REST catalog with vending), neither
needs Spark.

## Comparison

| Candidate | License | Delta support | API | Governance | Cloud lock-in | Tier |
|---|---|---|---|---|---|---|
| **Path-based / no catalog** | Apache-2.0/MIT | **Native** | none (path) | object-store IAM only | None | **Default (local/on-prem)** |
| **Unity Catalog OSS** | **Apache-2.0** | **Native/Delta-origin** | REST + HMS + RO Iceberg-REST | RBAC + auth (no tags/lineage in OSS) | None (self-host) | **First OSS catalog** |
| Apache Polaris | Apache-2.0 | pointer-only (beta, no commit coord) | Iceberg REST + mgmt | RBAC + vending | None | Iceberg-first; skip for Delta |
| Apache Gravitino | Apache-2.0 | external-metadata only | REST + Iceberg-REST | strongest OSS (lineage/tags/policy) | None | Optional (federation) |
| Apache Atlas | Apache-2.0 | none native | REST v2 | lineage/tags + Ranger policy | None but very heavy | Interop-only; don't self-host |
| Microsoft Purview | Proprietary SaaS | Parquet resource set | Atlas 2.2 REST | classification/lineage/policy | Azure-only | Cloud adapter (healthcare: yes) |
| Dataplex + BigLake | Proprietary SaaS | read-only (GCS) | REST/Iceberg-REST | lineage/Auto-DQ/policy tags | GCP-only | Cloud adapter (secondary) |

## Consequences

- The standalone product ships with **zero required catalog dependency** (path-based
  default) — the simplest possible local/on-prem story — and a real OSS catalog
  (UC OSS) for multi-engine/governed deployments, with cloud adapters as thin
  open-wire bridges. No Spark anywhere.
- `_meta.promotion_watermarks` (ADR-0026) and the medallion tables register through
  whichever binding is active (or just exist as paths under `NoCatalog`).
- The capability-gated optional ops are exactly the commercial-module attach points
  (ADR-0023 open-core).

## Open questions / smoke-tests before coding (flagged, non-blocking)

- delta-rs read against **OSS** UC (not Databricks) with vended creds — verify the
  full path end-to-end (no single primary doc demonstrates it).
- delta-rs UC OSS client (`deltalake-catalog-unity`) read/register path end-to-end with vended creds.
- UC OSS is pre-1.0 — track its 1.0 and the tags/lineage roadmap before committing it
  as the *only* governed binding for enterprise deals.
