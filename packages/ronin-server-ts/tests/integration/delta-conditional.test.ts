/**
 * REST surface — reference search (?subject=Patient/x) + conditional create (If-None-Exist).
 * Gated on RONIN_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: reference search + conditional create", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const req = (m: string, p: string, b?: unknown, h?: Record<string, string>) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json", ...(h ?? {}) }, body: b ? JSON.stringify(b) : undefined }));
  const total = async (p: string) => (await (await req("GET", p)).json()).total;

  beforeAll(async () => {
    if (SIDECAR && !(await wh.health())) throw new Error("sidecar down");
  });

  it("reference search (?subject=Patient/x)", async () => {
    const pid = `rp${ts}`;
    await req("POST", "/Patient", { resourceType: "Patient", id: pid, name: [{ family: "Ref" }] });
    await req("POST", "/Observation", { resourceType: "Observation", id: `ro${ts}`, status: "final", code: { text: "x" }, subject: { reference: `Patient/${pid}` } });
    expect(await total(`/Observation?subject=Patient/${pid}`)).toBe(1);
    expect(await total(`/Observation?subject=Patient/none${ts}`)).toBe(0);
  });

  it("conditional create is idempotent (If-None-Exist)", async () => {
    const sys = `urn:c${ts}`;
    const body = { resourceType: "Patient", identifier: [{ system: sys, value: "A" }], name: [{ family: "Cond" }] };
    const r1 = await req("POST", "/Patient", body, { "If-None-Exist": `identifier=${sys}|A` });
    expect(r1.status).toBe(201); // none existed → created
    const r2 = await req("POST", "/Patient", body, { "If-None-Exist": `identifier=${sys}|A` });
    expect(r2.status).toBe(200); // one exists → not created
    expect(await total(`/Patient?identifier=${encodeURIComponent(`${sys}|A`)}`)).toBe(1); // still exactly one
  });

  it("conditional create with multiple matches → 412", async () => {
    const sys = `urn:m${ts}`;
    // two resources share the identifier (plain creates, no conditional)
    await req("POST", "/Patient", { resourceType: "Patient", id: `m1${ts}`, identifier: [{ system: sys, value: "B" }] });
    await req("POST", "/Patient", { resourceType: "Patient", id: `m2${ts}`, identifier: [{ system: sys, value: "B" }] });
    const r = await req("POST", "/Patient", { resourceType: "Patient", identifier: [{ system: sys, value: "B" }] }, { "If-None-Exist": `identifier=${sys}|B` });
    expect(r.status).toBe(412);
  });
});
