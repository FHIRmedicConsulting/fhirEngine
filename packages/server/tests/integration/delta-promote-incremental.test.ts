/**
 * CDF-incremental promotion (ADR-0026 optimization) over real delta-rs: first run full-rebuilds
 * and stamps the watermark (gold/promote_state); later runs read the Bronze Change Data Feed,
 * promote ONLY the changed ids, and advance the watermark; unchanged Bronze → noop. Gated on
 * FHIRENGINE_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { promoteIncremental } from "../../src/repository/promote.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("CDF-incremental promotion", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const run = `inc${Date.now()}`;
  const A = `${run}-a`;
  const B = `${run}-b`;
  const C = `${run}-c`;

  const bronzeObs = (id: string, ver: number, status: string) => ({
    id,
    version_id: ver,
    last_updated: `2026-08-07T00:00:0${ver}Z`,
    body_json: JSON.stringify({
      resourceType: "Observation", id, status,
      code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
    }),
    identifier_index: [],
    search_param_index: [{ code: "code", system: "http://loinc.org", value: "8480-6" }],
    ext_json: "{}",
    deleted: false,
    is_current: true,
    _ingested_at: "2026-08-07T00:00:00Z",
    _ingest_source: "inc-test",
  });

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error(`sidecar not reachable at ${SIDECAR}`);
    await wh.writeBronze("Observation", bronzeObs(A, 1, "preliminary") as never);
    await wh.writeBronze("Observation", bronzeObs(B, 1, "final") as never);
  });

  it("first run full-rebuilds and stamps the watermark", async () => {
    const r = await promoteIncremental(wh, "Observation");
    expect(r.mode).toBe("full");
    expect(r.currentIds).toBeGreaterThanOrEqual(2);
    wh.registerPromoteState();
    const state = await wh.query<{ resource_type: string; bronze_version: number }>(
      "SELECT resource_type, bronze_version FROM promote_state WHERE resource_type = ?", ["Observation"]);
    expect(state).toHaveLength(1);
    expect(Number(state[0]!.bronze_version)).toBeGreaterThanOrEqual(0);
  });

  it("unchanged Bronze → noop (no rows touched, watermark preserved)", async () => {
    const r = await promoteIncremental(wh, "Observation");
    expect(r.mode).toBe("noop");
    expect(r.gold).toBe(0);
    expect(r.silver).toBe(0);
  });

  it("promotes ONLY the ids changed since the watermark and advances it", async () => {
    await wh.writeBronze("Observation", bronzeObs(A, 2, "final") as never); // update A
    await wh.writeBronze("Observation", bronzeObs(C, 1, "final") as never); // create C
    const r = await promoteIncremental(wh, "Observation");
    expect(r.mode).toBe("incremental");
    expect(r.currentIds).toBe(2); // A + C only — B untouched
    expect(r.fromVersion).toBeDefined();
    expect(r.toVersion!).toBeGreaterThan(r.fromVersion!);

    // Gold reflects the incremental upserts: A is now v2/final, C exists, B still v1.
    const gold = wh.registerTier("gold", "Observation");
    const rows = await wh.query<{ id: string; version_id: number; body_json: string }>(
      `SELECT id, version_id, body_json FROM ${gold} WHERE id IN (?, ?, ?)`, [A, B, C]);
    const byId = new Map(rows.map((x) => [x.id, x]));
    expect(Number(byId.get(A)!.version_id)).toBe(2);
    expect(JSON.parse(byId.get(A)!.body_json).status).toBe("final");
    expect(Number(byId.get(B)!.version_id)).toBe(1);
    expect(byId.get(C)).toBeDefined();

    // Silver upserted by silver_id for the changed ids.
    const silver = wh.registerTier("silver", "Observation");
    const srows = await wh.query<{ fhir_id: string; version_id: number }>(
      `SELECT fhir_id, version_id FROM ${silver} WHERE fhir_id IN (?, ?, ?)`, [A, B, C]);
    const sById = new Map(srows.map((x) => [x.fhir_id, x]));
    expect(Number(sById.get(A)!.version_id)).toBe(2);
    expect(sById.get(C)).toBeDefined();
  });

  it("a second unchanged run after the incremental is again a noop", async () => {
    const r = await promoteIncremental(wh, "Observation");
    expect(r.mode).toBe("noop");
  });

  it("Patient with MPI enabled always takes the full path (identity space is global)", async () => {
    const r = await promoteIncremental(wh, "Patient");
    expect(r.mode).toBe("full");
  });
});
