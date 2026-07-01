/**
 * Reference search by BARE id (FHIR: `patient=123` must match a stored `Patient/123`) — the
 * common Inferno / US Core form. Regression: our index stores the full `Type/id` and only
 * exact-matched, so patient-scoped clinical searches returned nothing. Sidecar-gated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("reference search — bare id vs full Type/id", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const pid = `refpat-${Date.now()}`;
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));
  const total = async (q: string) => (await (await req("GET", q)).json()).total as number;

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    await req("POST", "/Patient", { resourceType: "Patient", id: pid });
    await req("POST", "/Observation", {
      resourceType: "Observation", status: "final",
      code: { text: "hr" }, subject: { reference: `Patient/${pid}` },
    });
  });

  it("bare id matches the stored Type/id reference", async () => {
    expect(await total(`/Observation?patient=${pid}`)).toBe(1);       // bare id (Inferno form)
    expect(await total(`/Observation?patient=Patient/${pid}`)).toBe(1); // full reference
    expect(await total(`/Observation?subject=${pid}`)).toBe(1);        // works for subject too
  });

  it("a non-matching bare id returns nothing (no over-match)", async () => {
    expect(await total(`/Observation?patient=nope-${pid}`)).toBe(0);
  });
});
