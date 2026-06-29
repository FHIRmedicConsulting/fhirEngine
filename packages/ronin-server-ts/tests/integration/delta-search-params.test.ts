/**
 * REST surface — per-resource search params (token/string/date) over the materialized
 * search index, incl. multi-param AND. Gated on RONIN_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: per-resource search params", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const fam = `zt${ts}`; // unique family prefix isolates these from other tests' data
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));
  const total = async (p: string) => (await (await req("GET", p)).json()).total;

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}1`, name: [{ family: `${fam}alpha`, given: ["Anna"] }], gender: "female", birthDate: "1980-05-05" });
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}2`, name: [{ family: `${fam}beta` }], gender: "male", birthDate: "1990-01-01" });
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}3`, name: [{ family: `${fam}gamma` }], gender: "female", birthDate: "1960-12-12" });
  });

  it("string search (name, case-insensitive prefix)", async () => {
    expect(await total(`/Patient?name=${fam.toUpperCase()}`)).toBe(3); // case-insensitive
    expect(await total(`/Patient?family=${fam}alpha`)).toBe(1);
  });

  it("token search (gender), isolated via name AND", async () => {
    expect(await total(`/Patient?gender=male&name=${fam}`)).toBe(1);
    expect(await total(`/Patient?gender=female&name=${fam}`)).toBe(2);
  });

  it("date search (birthdate prefixes), isolated via name AND", async () => {
    expect(await total(`/Patient?birthdate=gt1985&name=${fam}`)).toBe(1); // P2 1990
    expect(await total(`/Patient?birthdate=lt1970&name=${fam}`)).toBe(1); // P3 1960
    expect(await total(`/Patient?birthdate=ge1980&name=${fam}`)).toBe(2); // P1 1980, P2 1990
  });

  it("multi-param AND (gender + birthdate + name)", async () => {
    expect(await total(`/Patient?gender=female&birthdate=lt1970&name=${fam}`)).toBe(1); // P3 only
    expect(await total(`/Patient?gender=male&birthdate=lt1970&name=${fam}`)).toBe(0); // none
  });
});
