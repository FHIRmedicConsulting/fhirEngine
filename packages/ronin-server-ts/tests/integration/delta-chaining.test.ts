/**
 * REST surface — chained search (ref.param), reverse chaining (_has), and _summary/_elements.
 * Gated on RONIN_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: chaining + _has + _summary/_elements", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const fam = `zc${ts}`;
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));
  const json = async (p: string) => await (await req("GET", p)).json();
  const sys = `urn:cc${ts}`;

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    // Two patients; Observations referencing each, one with a specific code.
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}A`, name: [{ family: `${fam}smith` }] });
    await req("POST", "/Patient", { resourceType: "Patient", id: `${fam}B`, name: [{ family: `${fam}jones` }] });
    await req("POST", "/Observation", { resourceType: "Observation", id: `${fam}o1`, status: "final", code: { coding: [{ system: sys, code: "vt" }] }, subject: { reference: `Patient/${fam}A` } });
    await req("POST", "/Observation", { resourceType: "Observation", id: `${fam}o2`, status: "final", code: { coding: [{ system: sys, code: "other" }] }, subject: { reference: `Patient/${fam}B` } });
  });

  it("chained search: Observation?subject.name=", async () => {
    const b = await json(`/Observation?subject.name=${fam}smith`);
    expect(b.total).toBe(1); // only o1 (subject = patient A 'smith')
    expect(b.entry[0].resource.id).toBe(`${fam}o1`);
  });

  it("reverse chaining: Patient?_has:Observation:subject:code=", async () => {
    const b = await json(`/Patient?_has:Observation:subject:code=${encodeURIComponent(`${sys}|vt`)}`);
    expect(b.total).toBe(1); // patient A has an Observation with code vt
    expect(b.entry[0].resource.id).toBe(`${fam}A`);
  });

  it("_summary=count returns totals only", async () => {
    const b = await json(`/Patient?name=${fam}&_summary=count`);
    expect(b.total).toBe(2);
    expect(b.entry).toBeUndefined();
  });

  it("_elements trims returned elements", async () => {
    const b = await json(`/Patient?_id=${fam}A&_elements=name`);
    const res = b.entry[0].resource;
    expect(res.name).toBeTruthy();
    expect(res.id).toBe(`${fam}A`); // id/meta always kept
    expect(res.text).toBeUndefined();
  });
});
