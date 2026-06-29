/**
 * REST surface — _include / _revinclude + conditional update/delete by search.
 * Gated on RONIN_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: _include/_revinclude + conditional update/delete", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));
  const json = async (p: string) => (await (await req("GET", p)).json());

  beforeAll(async () => {
    if (SIDECAR && !(await wh.health())) throw new Error("sidecar down");
  });

  it("_include resolves referenced resources (Observation:subject → Patient)", async () => {
    const pid = `ip${ts}`;
    await req("POST", "/Patient", { resourceType: "Patient", id: pid, name: [{ family: "Inc" }] });
    await req("POST", "/Observation", { resourceType: "Observation", id: `io${ts}`, status: "final", code: { text: "x" }, subject: { reference: `Patient/${pid}` } });
    const b = await json(`/Observation?subject=Patient/${pid}&_include=Observation:subject`);
    expect(b.total).toBe(1); // includes don't inflate total
    const modes = b.entry.map((e: any) => `${e.resource.resourceType}:${e.search.mode}`);
    expect(modes).toContain("Observation:match");
    expect(modes).toContain("Patient:include");
  });

  it("_revinclude resolves referencing resources (Patient ← Observation:subject)", async () => {
    const pid = `rp${ts}`;
    await req("POST", "/Patient", { resourceType: "Patient", id: pid, name: [{ family: "Rev" }] });
    await req("POST", "/Observation", { resourceType: "Observation", id: `rio${ts}`, status: "final", code: { text: "y" }, subject: { reference: `Patient/${pid}` } });
    const b = await json(`/Patient?_id=${pid}&_revinclude=Observation:subject`);
    const modes = b.entry.map((e: any) => `${e.resource.resourceType}:${e.search.mode}`);
    expect(modes).toContain("Patient:match");
    expect(modes).toContain("Observation:include");
  });

  it("conditional update by search creates then updates the same resource", async () => {
    const sys = `urn:cu${ts}`;
    const q = `identifier=${encodeURIComponent(`${sys}|U`)}`;
    const r1 = await req("PUT", `/Patient?${q}`, { resourceType: "Patient", identifier: [{ system: sys, value: "U" }], name: [{ family: "V1" }] });
    expect(r1.status).toBe(201); // 0 matches → create
    const r2 = await req("PUT", `/Patient?${q}`, { resourceType: "Patient", identifier: [{ system: sys, value: "U" }], name: [{ family: "V2" }] });
    expect(r2.status).toBe(200); // 1 match → update
    const b = await json(`/Patient?${q}`);
    expect(b.total).toBe(1);
    expect(b.entry[0].resource.name[0].family).toBe("V2");
  });

  it("conditional delete by search removes the match", async () => {
    const sys = `urn:cd${ts}`;
    const q = `identifier=${encodeURIComponent(`${sys}|D`)}`;
    await req("POST", "/Patient", { resourceType: "Patient", id: `cd${ts}`, identifier: [{ system: sys, value: "D" }] });
    expect((await req("DELETE", `/Patient?${q}`)).status).toBe(204);
    expect((await json(`/Patient?${q}`)).total).toBe(0);
  });
});
