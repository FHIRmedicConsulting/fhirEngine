/**
 * Medallion promotion (ADR-0026), full-rebuild first cut:
 *   Bronze (raw, append-only) → current-version per id →
 *     • Gold  = current-version transactional projection (body_json + ops; MERGE by id)
 *     • Silver = flattened + governance columns (clean-room flattener, ADR-0024)
 *
 * MPI / dedup (ADR-0012 v1, deterministic) is ENFORCED here — Silver and Gold carry
 * deduplicated identities: duplicate Patients (shared business identifier, guardrails
 * passing) are merged (survivor = latest write; merged record kept readable with a
 * `replaced-by` link but excluded from search), `Patient/<merged>` references in every
 * other promoted type are rewritten to the survivor, and the MPI tables
 * (patient_link / patient_match_review / patient_merge_history — all Gold, ADR-0012 §2)
 * are maintained. Disable with FHIRENGINE_MPI=off.
 *
 * Runs in TS (reusing the proven flattener) with all Delta I/O via the sidecar
 * (delta-rs). Full-rebuild is ADR-0026's correctness backstop; CDF-incremental is
 * the later optimization. Silver uses inferred Arrow schema and drops all-null
 * columns for now (explicit-schema is the follow-up).
 */
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { flattenResource } from "../fhir-schema/clean-room-flattener.js";
import { schemaFor } from "../fhir-schema/r4-registry.js";
import { resolveIdentities, rewriteReferences, type MpiResolution, type MpiPatientRow } from "./mpi.js";
import { uuidv7 } from "../lib/uuid-v7.js";

interface BronzeRow {
  id: string;
  version_id: number;
  last_updated: string;
  body_json: string;
  identifier_index: unknown;
  search_param_index: unknown;
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
  /** MPI outcomes (Patient promotion only). */
  merges?: number;
  reviews?: number;
}

const mpiEnabled = (): boolean => process.env.FHIRENGINE_MPI !== "off";

/** merged → survivor map from patient_merge_history (active merges only) — used when a
 * non-Patient type is promoted WITHOUT a same-run Patient resolution (single-type runs). */
export async function loadSurvivorMap(wh: DeltaWarehouse): Promise<Map<string, string>> {
  try {
    wh.registerMpi("patient_merge_history");
    const rows = await wh.query<{ surviving_fhir_id: string; merged_fhir_id: string }>(
      "SELECT surviving_fhir_id, merged_fhir_id FROM patient_merge_history WHERE unmerged_at IS NULL",
    );
    // Path-compress chains (A→B, later B→C) to their TERMINAL survivor, so a reference
    // resolves deterministically regardless of Map iteration order (A→C, not order-dependent
    // A→B or A→C). Guard against cycles.
    const direct = new Map(rows.map((r) => [r.merged_fhir_id, r.surviving_fhir_id]));
    const terminal = new Map<string, string>();
    for (const start of direct.keys()) {
      let cur = start; const seen = new Set<string>([start]);
      while (direct.has(cur)) {
        cur = direct.get(cur)!;
        if (seen.has(cur)) break; // cycle → stop
        seen.add(cur);
      }
      terminal.set(start, cur);
    }
    return terminal;
  } catch {
    return new Map(); // no merge history yet
  }
}

export interface PromoteOpts {
  /** Thread the Patient run's resolution into subsequent types (--all does this);
   * absent → loaded from patient_merge_history. */
  survivorOf?: Map<string, string>;
}

export async function promote(wh: DeltaWarehouse, resourceType: string, opts?: PromoteOpts): Promise<PromoteResult> {
  const bronze = wh.registerTier("bronze", resourceType);
  let rows: BronzeRow[];
  try {
    rows = await wh.query<BronzeRow>(
      `SELECT id, version_id, last_updated, body_json, identifier_index, search_param_index,
              ext_json, deleted, _ingested_at, _ingest_source FROM ${bronze}`,
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
  let currentRows = [...current.values()];
  const now = new Date().toISOString();

  // ── MPI / dedup enforcement (ADR-0012 v1 deterministic) ───────────────────────
  let mpi: MpiResolution | null = null;
  if (mpiEnabled() && resourceType === "Patient") {
    mpi = resolveIdentities(
      currentRows.filter((r) => !r.deleted).map((r): MpiPatientRow => ({
        id: r.id, last_updated: r.last_updated, body: JSON.parse(r.body_json),
      })),
    );
    if (mpi.merges.length || mpi.reviews.length || mpi.links.size) {
      currentRows = applyPatientMerges(currentRows, mpi);
      await writeMpiTables(wh, mpi, now);
      await writeMergeProvenance(wh, mpi, now);
    }
  } else if (mpiEnabled() && resourceType !== "Patient") {
    // Dedup enforcement for downstream types: rewrite merged→survivor references so
    // Silver/Gold clinical data hangs off the golden record.
    const survivorOf = opts?.survivorOf ?? (await loadSurvivorMap(wh));
    if (survivorOf.size) {
      currentRows = currentRows.map((r) => ({
        ...r,
        body_json: rewriteReferences(r.body_json, survivorOf),
        search_param_index: rewriteIndexRefs(r.search_param_index, survivorOf),
      }));
    }
  }

  // Gold — current-version projection (same Bronze shape: search/identifier indexes ride
  // along so the serve tier answers searches), MERGE-upsert by id. All Gold rows are the
  // current version by construction — EXCEPT merged-away Patients (is_current=false:
  // readable by id with their replaced-by link, excluded from every search).
  if (currentRows.length) {
    const goldRows = currentRows.map((r) => ({ ...r, is_current: r._mpi_merged !== true }));
    for (const g of goldRows) delete (g as Record<string, unknown>)._mpi_merged;
    await wh.mergeTier("gold", resourceType, goldRows, "id", "bronze");
  }

  // Silver — flattened + governance, current version. Full-rebuild (overwrite).
  const cols = schemaFor(resourceType);
  const silverRaw = currentRows.map((r) => ({
    silver_id: r.id,
    fhir_id: r.id,
    version_id: Number(r.version_id),
    silver_status: r._mpi_merged === true ? "merged" : "pass",
    governed_at: now,
    deleted: r.deleted ?? false,
    body_json: r.body_json, // source-of-truth retained (post-MPI: links/rewrites applied)
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
    ...(mpi ? { merges: mpi.merges.length, reviews: mpi.reviews.length } : {}),
  };
}

/** Apply auto-merges to the current Patient rows (ADR-0012 merge semantics):
 * survivor gains `link[replaces]` + the merged record's identifier/search index entries
 * (old MRNs resolve to the golden record); merged gets `active=false` + `link[replaced-by]`
 * and is flagged for is_current=false in Gold (read-by-id only). */
function applyPatientMerges(rows: BronzeRow[], mpi: MpiResolution): BronzeRow[] {
  if (!mpi.merges.length) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const m of mpi.merges) {
    const survivor = byId.get(m.survivorId);
    const merged = byId.get(m.mergedId);
    if (!survivor || !merged) continue;
    const sBody = JSON.parse(survivor.body_json);
    sBody.link = [...(sBody.link ?? []), { other: { reference: `Patient/${m.mergedId}` }, type: "replaces" }];
    survivor.body_json = JSON.stringify(sBody);
    survivor.identifier_index = unionIndex(survivor.identifier_index, merged.identifier_index);
    survivor.search_param_index = unionIndex(survivor.search_param_index, merged.search_param_index);
    const mBody = JSON.parse(merged.body_json);
    mBody.active = false;
    mBody.link = [...(mBody.link ?? []), { other: { reference: `Patient/${m.survivorId}` }, type: "replaced-by" }];
    merged.body_json = JSON.stringify(mBody);
    (merged as Record<string, unknown>)._mpi_merged = true;
  }
  return rows;
}

function unionIndex(a: unknown, b: unknown): unknown[] {
  const list = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  const seen = new Set<string>();
  return list.filter((e) => { const k = JSON.stringify(e); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Rewrite Patient references inside a search_param_index array (reference params store
 * the `Patient/<id>` form). */
function rewriteIndexRefs(index: unknown, survivorOf: Map<string, string>): unknown {
  if (!Array.isArray(index) || !survivorOf.size) return index;
  return index.map((e) => {
    const v = (e as { value?: unknown })?.value;
    if (typeof v !== "string" || !v.startsWith("Patient/")) return e;
    const survivor = survivorOf.get(v.slice("Patient/".length));
    return survivor ? { ...(e as object), value: `Patient/${survivor}` } : e;
  });
}

/** Maintain the Gold MPI tables (ADR-0012 §2). patient_link is authoritative → full-rebuild
 * overwrite (idempotent). Merge history + review queue are append-only → append only rows
 * not already present (re-runs don't duplicate; steward decision rows are never touched). */
async function writeMpiTables(wh: DeltaWarehouse, mpi: MpiResolution, now: string): Promise<void> {
  if (mpi.links.size) {
    await wh.writeMpi("patient_link", [...mpi.links.entries()].map(([key, fhirId]) => {
      const [system, value] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      return {
        identifier_system: system, identifier_value: value, resource_type: "Patient",
        fhir_id: fhirId, is_active: true, decision_path: "deterministic_rule:shared-identifier", assigned_at: now,
      };
    }), "overwrite");
  }

  let existingMerges = new Set<string>();
  try {
    wh.registerMpi("patient_merge_history");
    const rows = await wh.query<{ surviving_fhir_id: string; merged_fhir_id: string }>(
      "SELECT surviving_fhir_id, merged_fhir_id FROM patient_merge_history WHERE unmerged_at IS NULL");
    existingMerges = new Set(rows.map((r) => `${r.surviving_fhir_id}~${r.merged_fhir_id}`));
  } catch { /* first run */ }
  const newMerges = mpi.merges.filter((m) => !existingMerges.has(`${m.survivorId}~${m.mergedId}`));
  if (newMerges.length) {
    await wh.writeMpi("patient_merge_history", newMerges.map((m) => ({
      merge_id: uuidv7(), surviving_fhir_id: m.survivorId, merged_fhir_id: m.mergedId,
      merged_at: now, merge_reason: `${m.rule} [${m.sharedIdentifiers.join(", ")}]`,
      merge_actor: "system", unmerged_at: null as string | null,
    })), "append");
  }

  let existingReviews = new Set<string>();
  try {
    wh.registerMpi("patient_match_review");
    const rows = await wh.query<{ candidate_ids: string }>("SELECT candidate_ids FROM patient_match_review");
    existingReviews = new Set(rows.map((r) => r.candidate_ids));
  } catch { /* first run */ }
  const newReviews = mpi.reviews.filter((r) => !existingReviews.has([...r.ids].sort().join(",")));
  if (newReviews.length) {
    await wh.writeMpi("patient_match_review", newReviews.map((r) => ({
      review_id: uuidv7(), candidate_ids: [...r.ids].sort().join(","), reason: r.reason,
      shared_identifiers: r.sharedIdentifiers.join(", "), evidence_json: JSON.stringify(r.evidence),
      suggested_action: r.reason === "multi_match" ? "steward_pick_survivor" : "verify_distinct",
      status: "pending", created_at: now,
    })), "append");
  }
}

/** Audit Provenance per auto-merge decision (ADR-0012 §8) — landed in Bronze like any
 * resource; the Provenance promotion pass serves it from Gold. */
async function writeMergeProvenance(wh: DeltaWarehouse, mpi: MpiResolution, now: string): Promise<void> {
  for (const m of mpi.merges) {
    const id = uuidv7();
    const body = {
      resourceType: "Provenance",
      id,
      target: [{ reference: `Patient/${m.survivorId}` }, { reference: `Patient/${m.mergedId}` }],
      recorded: now,
      activity: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "MERGE" }] },
      agent: [{ who: { display: "fhirengine-promote (deterministic MPI, ADR-0012 v1)" } }],
      reason: [{ text: `${m.rule} [${m.sharedIdentifiers.join(", ")}]` }],
    };
    await wh.writeBronze("Provenance", {
      id, version_id: 1, last_updated: now, body_json: JSON.stringify(body),
      identifier_index: [], search_param_index: [
        { code: "target", system: "", value: `Patient/${m.survivorId}` },
        { code: "target", system: "", value: `Patient/${m.mergedId}` },
      ],
      ext_json: "{}", deleted: false, is_current: true, _ingested_at: now, _ingest_source: "mpi-merge",
    });
  }
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
