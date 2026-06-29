/**
 * REST surface — search v2: _id, _lastUpdated (date prefixes), _count/_getpagesoffset
 * paging (+ next link), and the existing identifier token search. Gated on sidecar.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: search v2", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const sys = `urn:s${Date.now()}`;
  const ids = [`s${Date.now()}a`, `s${Date.now()}b`, `s${Date.now()}c`];
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    for (let i = 0; i < ids.length; i++) {
      await req("POST", "/Patient", { resourceType: "Patient", id: ids[i], identifier: [{ system: sys, value: `v${i}` }], name: [{ family: `S${i}` }] });
    }
  });

  it("searches by _id", async () => {
    const b = await (await req("GET", `/Patient?_id=${ids[0]}`)).json();
    expect(b.total).toBe(1);
    expect(b.entry[0].resource.id).toBe(ids[0]);
  });

  it("pages with _count and emits a next link", async () => {
    const b = await (await req("GET", "/Patient?_count=2")).json();
    expect(b.type).toBe("searchset");
    expect(b.entry.length).toBe(2);
    expect(b.total).toBeGreaterThanOrEqual(3);
    expect(b.link.some((l: any) => l.relation === "next")).toBe(true);
    const next = b.link.find((l: any) => l.relation === "next").url.replace("http://test", "");
    const b2 = await (await req("GET", next)).json();
    expect(b2.entry.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by _lastUpdated date prefix", async () => {
    const b = await (await req("GET", "/Patient?_lastUpdated=gt2000-01-01&_count=100")).json();
    expect(b.total).toBeGreaterThanOrEqual(3);
    const b0 = await (await req("GET", "/Patient?_lastUpdated=lt2000-01-01")).json();
    expect(b0.total).toBe(0);
  });

  it("still supports identifier token search", async () => {
    const b = await (await req("GET", `/Patient?identifier=${encodeURIComponent(`${sys}|v1`)}`)).json();
    expect(b.total).toBe(1);
    expect(b.entry[0].resource.id).toBe(ids[1]);
  });
});
