/**
 * POST [type]/_search (FHIR search spec; US Core / (g)(10) require it — Inferno's _id search
 * issues a POST /_search) + startup table discovery (a restarted server must read data it did
 * not write this process; registration is otherwise in-memory). Sidecar-gated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("POST _search + startup table discovery", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const id = `ps-${Date.now()}`;
  const req = (m: string, p: string, b?: unknown, h?: Record<string, string>) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json", ...(h ?? {}) }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    await req("POST", "/Patient", { resourceType: "Patient", id, gender: "female", name: [{ family: "Searcher" }] });
  });

  it("POST /Patient/_search (form-encoded) returns the same searchset as GET", async () => {
    const res = await app.fetch(new Request("http://test/Patient/_search", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `_id=${id}`,
    }));
    const b = await res.json();
    expect(res.status).toBe(200);
    expect(b.type).toBe("searchset");
    expect(b.total).toBe(1);
    expect(b.entry[0].resource.id).toBe(id);
  });

  it("POST _search merges form body + URL query params", async () => {
    const res = await app.fetch(new Request("http://test/Patient/_search?gender=female", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `_id=${id}`,
    }));
    expect((await res.json()).total).toBe(1);
  });

  it("a fresh warehouse (simulated restart) registers on-disk tables and can read them", async () => {
    const fresh = new DeltaWarehouse({ sidecarUrl: SIDECAR!, base: BASE });
    const registered = await fresh.registerExistingTables();
    expect(registered).toContain("patient"); // discovered the bronze/patient table written above
    const freshApp = createDeltaApp({ warehouse: fresh, baseUrl: "http://test" });
    const res = await freshApp.fetch(new Request(`http://test/Patient/${id}`));
    expect(res.status).toBe(200); // readable without any write in this warehouse instance
  });
});
