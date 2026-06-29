/**
 * Medallion promotion (ADR-0026), full-rebuild first cut:
 *   Bronze (raw, append-only) → current-version per id →
 *     • Gold  = current-version transactional projection (body_json + ops; MERGE by id)
 *     • Silver = flattened + governance columns (clean-room flattener, ADR-0024)
 *
 * Runs in TS (reusing the proven flattener) with all Delta I/O via the sidecar
 * (delta-rs). Full-rebuild is ADR-0026's correctness backstop; CDF-incremental is
 * the later optimization. Silver uses inferred Arrow schema and drops all-null
 * columns for now (explicit-schema is the follow-up).
 */
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { flattenResource } from "../fhir-schema/clean-room-flattener.js";
import { schemaFor } from "../fhir-schema/r4-registry.js";

interface BronzeRow {
  id: string;
  version_id: number;
  last_updated: string;
  body_json: string;
  identifier_index: unknown;
  ext_json: string;
  deleted: boolean | null;
  _ingested_at?: string | null;
  _ingest_source?: string | null;
  [k: string]: unknown;
}

export interface PromoteResult {
  resourceType: string;
  bronzeRows: number;
  currentIds: number;
  gold: number;
  silver: number;
}

export async function promote(wh: DeltaWarehouse, resourceType: string): Promise<PromoteResult> {
  const bronze = wh.registerTier("bronze", resourceType);
  let rows: BronzeRow[];
  try {
    rows = await wh.query<BronzeRow>(
      `SELECT id, version_id, last_updated, body_json, identifier_index, ext_json,
              deleted, _ingested_at, _ingest_source FROM ${bronze}`,
    );
  } catch {
    return { resourceType, bronzeRows: 0, currentIds: 0, gold: 0, silver: 0 };
  }

  // Current version per id (append-only Bronze → max version_id wins).
  const current = new Map<string, BronzeRow>();
  for (const r of rows) {
    const prev = current.get(r.id);
    if (!prev || Number(r.version_id) > Number(prev.version_id)) current.set(r.id, r);
  }
  const currentRows = [...current.values()];

  // Gold — current-version projection (same Bronze shape), MERGE-upsert by id.
  if (currentRows.length) {
    await wh.mergeTier("gold", resourceType, currentRows, "id", "bronze");
  }

  // Silver — flattened + governance, current version. Full-rebuild (overwrite).
  const cols = schemaFor(resourceType);
  const now = new Date().toISOString();
  const silverRaw = currentRows.map((r) => ({
    silver_id: r.id,
    fhir_id: r.id,
    version_id: Number(r.version_id),
    silver_status: "pass",
    governed_at: now,
    deleted: r.deleted ?? false,
    body_json: r.body_json, // source-of-truth retained
    ...flattenResource(JSON.parse(r.body_json), cols),
  })) as Record<string, unknown>[];
  const silverRows = pruneAllNullColumns(silverRaw);
  if (silverRows.length) {
    await wh.writeTier("silver", resourceType, silverRows, "infer", "overwrite");
  }

  return {
    resourceType,
    bronzeRows: rows.length,
    currentIds: current.size,
    gold: currentRows.length,
    silver: silverRows.length,
  };
}

/** Drop columns that are null in every row so inferred Arrow types stay concrete. */
function pruneAllNullColumns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!rows.length) return rows;
  const keep = new Set<string>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined) keep.add(k);
  }
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))));
}
