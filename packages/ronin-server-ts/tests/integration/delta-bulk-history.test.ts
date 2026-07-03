/**
 * REST surface — system _history, $export (bulk data), and _sort by param.
 * Gated on RONIN_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";
const EXPORT_DIR = `./.delta-test-export-${Date.now()}`; // cleaned by the .delta-test* sweep

describe.skipIf(!SIDECAR)("REST: system _history + $export + _sort", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const fam = `zb${ts}`;
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    process.env.RONIN_EXPORT_DIR = EXPORT_DIR;
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}1`, name: [{ family: `${fam}a` }], birthDate: "1990-01-01" });
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}2`, name: [{ family: `${fam}b` }], birthDate: "1970-01-01" });
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}3`, name: [{ family: `${fam}c` }], birthDate: "1980-01-01" });
  });

  it("system _history returns a merged history bundle", async () => {
    const b = await (await req("GET", "/_history?_count=500")).json();
    expect(b.type).toBe("history");
    expect(b.total).toBeGreaterThanOrEqual(3);
    expect(b.entry[0].request.method).toBeTruthy();
  });

  it("_sort by param (birthdate ascending)", async () => {
    const b = await (await req("GET", `/Patient?family=${fam}&_sort=birthdate`)).json();
    const dates = b.entry.map((e: any) => e.resource.birthDate);
    expect(dates).toEqual(["1970-01-01", "1980-01-01", "1990-01-01"]); // ascending
    const bDesc = await (await req("GET", `/Patient?family=${fam}&_sort=-birthdate`)).json();
    expect(bDesc.entry.map((e: any) => e.resource.birthDate)).toEqual(["1990-01-01", "1980-01-01", "1970-01-01"]);
  });

  it("$export: async kickoff → poll status → ndjson file → delete", async () => {
    const kick = await req("GET", "/Patient/$export?_type=Patient");
    expect(kick.status).toBe(202);
    const statusUrl = kick.headers.get("Content-Location")!.replace("http://test", "");
    expect(statusUrl).toContain("/_export-status/");
    // poll the async job to completion (202 in-progress → 200 manifest)
    let manifest: any, status = 0;
    for (let i = 0; i < 100; i++) {
      const s = await req("GET", statusUrl);
      status = s.status;
      if (status === 200) { manifest = await s.json(); break; }
      expect(status).toBe(202); // still running
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe(200);
    const out = manifest.output.find((o: any) => o.type === "Patient");
    expect(out).toBeTruthy();
    expect(out.count).toBeGreaterThanOrEqual(3);
    const fileRes = await req("GET", out.url.replace("http://test", ""));
    expect(fileRes.headers.get("Content-Type")).toContain("ndjson");
    const lines = (await fileRes.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0].resourceType).toBe("Patient");
    // delete the job → subsequent status is gone (404)
    expect((await req("DELETE", statusUrl)).status).toBe(202);
    expect((await req("GET", statusUrl)).status).toBe(404);
  });

  afterAll(async () => { await rm(EXPORT_DIR, { recursive: true, force: true }); });
});
