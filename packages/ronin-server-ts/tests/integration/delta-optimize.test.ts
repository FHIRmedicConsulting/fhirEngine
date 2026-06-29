/**
 * Store maintenance (Priority #1): Delta OPTIMIZE + Z-ORDER + VACUUM across the whole store.
 * Append-per-write makes many small files; optimize-all compacts them, clusters Bronze by `id`
 * (data skipping for id-keyed access), and vacuum reclaims tombstoned files — while every table
 * stays queryable. Gated on the sidecar.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("store maintenance — optimize + vacuum", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    // 25 separate creates → 25 small Bronze files (append-per-write)
    for (let i = 0; i < 25; i++) {
      await req("POST", "/Patient", { resourceType: "Patient", id: `opt${ts}-${i}`, name: [{ family: `O${i}` }] });
    }
  });

  it("optimize-all compacts many small files into few + clusters Bronze by id", async () => {
    const report: any = await wh.optimizeAll({ vacuum: false });
    expect(report.tables_optimized).toBeGreaterThanOrEqual(1);
    const patient = report.results["bronze/patient"];
    expect(patient).toBeTruthy();
    expect(patient.files_before).toBeGreaterThanOrEqual(20); // ~25 small files
    expect(patient.files_after).toBeLessThan(patient.files_before); // compacted
    expect(patient.zorder).toEqual(["id"]); // auto-clustered by id (Bronze has an id column)
  });

  it("--no-zorder falls back to plain compaction (no clustering)", async () => {
    // create a couple more small files first so there is something to compact
    for (let i = 100; i < 104; i++) await req("POST", "/Patient", { resourceType: "Patient", id: `opt${ts}-${i}` });
    const report: any = await wh.optimizeAll({ vacuum: false, zorder: false });
    expect(report.results["bronze/patient"].zorder).toBeNull(); // plain compact, no z-order
  });

  it("the table is still fully queryable after optimize", async () => {
    const b = await (await req("GET", `/Patient?_id=opt${ts}-7`)).json();
    expect(b.total).toBe(1);
    expect(b.entry[0].resource.id).toBe(`opt${ts}-7`);
  });

  it("vacuum (force, retention 0) reclaims the now-unreferenced pre-compaction files", async () => {
    const report: any = await wh.optimizeAll({ vacuum: true, retentionHours: 0, force: true });
    const patient = report.results["bronze/patient"];
    expect(patient.vacuumed_files).toBeGreaterThanOrEqual(1); // old small files physically removed
    // still queryable after vacuum
    expect((await (await req("GET", `/Patient?_id=opt${ts}-3`)).json()).total).toBe(1);
  });
});
