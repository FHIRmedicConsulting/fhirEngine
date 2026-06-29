/**
 * Medallion promotion over real delta-rs/DataFusion: Bronze → Gold (current-version)
 * + Silver (flattened). Gated on RONIN_DELTA_SIDECAR_URL (start the sidecar first):
 *   python sidecar/delta_sidecar.py --port 8078 --base ./.delta-test
 *   RONIN_DELTA_SIDECAR_URL=http://127.0.0.1:8078 RONIN_DELTA_BASE=./.delta-test \
 *     npx vitest run tests/integration/delta-promote.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { promote } from "../../src/repository/promote.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("Medallion promotion (Bronze → Silver + Gold)", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const run = `pr${Date.now()}`;
  const A = `${run}-a`;
  const B = `${run}-b`;

  const bronze = (id: string, ver: number, gender: string, deleted: boolean) => ({
    id,
    version_id: ver,
    last_updated: `2026-06-28T00:00:0${ver}Z`,
    body_json: JSON.stringify({
      resourceType: "Patient", id, gender, birthDate: "1985-05-05",
      identifier: [{ system: "urn:ronin:test", value: id }],
    }),
    identifier_index: [{ system: "urn:ronin:test", value: id, typeCode: null }],
    ext_json: "{}",
    deleted,
    _ingested_at: "2026-06-28T00:00:00Z",
    _ingest_source: "promote-test",
  });

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error(`sidecar not reachable at ${SIDECAR}`);
    // A: v1 female → v2 male (update). B: v1 female → v2 deleted tombstone.
    await wh.writeBronze("Patient", bronze(A, 1, "female", false));
    await wh.writeBronze("Patient", bronze(A, 2, "male", false));
    await wh.writeBronze("Patient", bronze(B, 1, "female", false));
    await wh.writeBronze("Patient", bronze(B, 2, "female", true));
  });

  it("promotes current-version to Gold + flattened to Silver", async () => {
    const res = await promote(wh, "Patient");
    expect(res.currentIds).toBeGreaterThanOrEqual(2);
    expect(res.gold).toBe(res.currentIds);
    expect(res.silver).toBe(res.currentIds);
  });

  it("Gold holds the current version per id (A→v2/male, B→tombstone)", async () => {
    const rows = await wh.query<{ id: string; version_id: number; deleted: boolean }>(
      `SELECT id, version_id, deleted FROM patient_gold WHERE id IN ('${A}','${B}')`,
    );
    const a = rows.find((r) => r.id === A)!;
    const b = rows.find((r) => r.id === B)!;
    expect(Number(a.version_id)).toBe(2);
    expect(a.deleted).toBe(false);
    expect(b.deleted).toBe(true);
  });

  it("Silver has flattened columns from the clean-room flattener", async () => {
    const rows = await wh.query<{ fhir_id: string; gender: string; birthDate: string }>(
      `SELECT fhir_id, gender, birthDate FROM patient_silver WHERE fhir_id = '${A}'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].gender).toBe("male");        // current version (v2)
    expect(rows[0].birthDate).toBe("1985-05-05"); // flattened scalar column
  });
});
