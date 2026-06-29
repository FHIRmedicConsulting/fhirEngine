/**
 * REST surface — search modifiers (:exact :contains :not :missing), number/quantity,
 * and combining per-resource params with base filters. Gated on RONIN_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: search modifiers + number/quantity", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const fam = `zm${ts}`;
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));
  const total = async (p: string) => (await (await req("GET", p)).json()).total;

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}1`, name: [{ family: `${fam}smith` }], gender: "female" });
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}2`, name: [{ family: `${fam}smithson` }], gender: "male" });
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}3`, name: [{ family: `${fam}jones` }], gender: "female" });
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}4`, name: [{ family: `${fam}nogen` }] }); // no gender
    // Observations with a coded code (token search matches coding, not text) + numeric value
    for (const [i, v] of [["a", 5], ["b", 10], ["c", 15]] as const) {
      await req("POST", "/Observation", { resourceType: "Observation", id: `vq${ts}${i}`, status: "final", code: { coding: [{ system: `urn:q${ts}`, code: "vt" }] }, valueQuantity: { value: v, unit: "mg", system: "http://unitsofmeasure.org" } });
    }
  });

  it(":exact vs default prefix (string)", async () => {
    expect(await total(`/Patient?family:exact=${fam}smith`)).toBe(1); // not smithson
    expect(await total(`/Patient?family=${fam}smith`)).toBe(2); // prefix → smith + smithson
  });

  it(":contains (string)", async () => {
    expect(await total(`/Patient?family:contains=${fam}smith`)).toBe(2); // smith + smithson
  });

  it(":not (token) excludes matches, keeps missing", async () => {
    expect(await total(`/Patient?family=${fam}&gender:not=male`)).toBe(3); // 2 female + 1 no-gender
  });

  it(":missing (token)", async () => {
    expect(await total(`/Patient?family=${fam}&gender:missing=true`)).toBe(1); // only the no-gender patient
    expect(await total(`/Patient?family=${fam}&gender:missing=false`)).toBe(3);
  });

  it("number/quantity comparison (+ token coding match)", async () => {
    const code = encodeURIComponent(`urn:q${ts}|vt`);
    expect(await total(`/Observation?code=${code}`)).toBe(3); // token search matches coding
    expect(await total(`/Observation?code=${code}&value-quantity=gt8`)).toBe(2); // 10, 15
    expect(await total(`/Observation?code=${code}&value-quantity=lt8`)).toBe(1); // 5
  });

  it("combines per-resource params with base filters", async () => {
    expect(await total(`/Patient?gender=female&family=${fam}`)).toBe(2);
    expect(await total(`/Patient?family=${fam}&_id=${fam}1`)).toBe(1); // param + _id
  });
});
