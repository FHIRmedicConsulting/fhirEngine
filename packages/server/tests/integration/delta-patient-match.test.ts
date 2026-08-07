/**
 * Patient/$match (probabilistic MPI) over real delta-rs: a seed Patient is scored against
 * stored candidates found by demographic blocking; the response is a graded searchset Bundle.
 * Gated on sidecar.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const ts = Date.now();
const BASE = `${process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test"}-match-${ts}`;

describe.skipIf(!SIDECAR)("Patient/$match — probabilistic MPI", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  let twin = "", typo = "", other = "";
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  const patient = (id: string, over: Record<string, unknown>) => ({
    resourceType: "Patient", id, ...over,
  });

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    // Exact twin (different MRN), a typo variant, and an unrelated patient.
    // POST (PUT-create 404s on an unprovisioned table; Run-14) and capture the assigned ids.
    const post = async (over: Record<string, unknown>) => (await (await req("POST", "/Patient", { resourceType: "Patient", ...over })).json()).id as string;
    twin = await post({
      identifier: [{ system: "urn:mrn", value: `MRN-twin-${ts}` }],
      name: [{ family: "Nakamura", given: ["Yuki"] }], birthDate: "1990-06-15", gender: "female",
      address: [{ postalCode: "98101" }], telecom: [{ system: "phone", value: "206-555-0142" }],
    });
    typo = await post({
      identifier: [{ system: "urn:mrn", value: `MRN-typo-${ts}` }],
      name: [{ family: "Nakamora", given: ["Yuki"] }], birthDate: "1990-06-15", gender: "female",
      address: [{ postalCode: "98101" }],
    });
    other = await post({
      name: [{ family: "Delacroix", given: ["Étienne"] }], birthDate: "1955-01-20", gender: "male",
      address: [{ postalCode: "70112" }],
    });
  });

  const match = (seed: Record<string, unknown>, extra: Array<Record<string, unknown>> = []) =>
    req("POST", "/Patient/$match", { resourceType: "Parameters", parameter: [{ name: "resource", resource: seed }, ...extra] });

  it("returns graded candidates for a seed with no shared identifier", async () => {
    const seed = { resourceType: "Patient", name: [{ family: "Nakamura", given: ["Yuki"] }], birthDate: "1990-06-15", gender: "female", address: [{ postalCode: "98101" }], telecom: [{ system: "phone", value: "206-555-0142" }] };
    const b = await (await match(seed)).json();
    expect(b.resourceType).toBe("Bundle");
    expect(b.type).toBe("searchset");
    const byId = new Map((b.entry ?? []).map((e: any) => [e.resource.id, e]));
    // exact twin → certain; typo variant → probable/certain; unrelated → absent
    const twinEntry = byId.get(twin) as any;
    expect(twinEntry.search.mode).toBe("match");
    expect(twinEntry.search.extension[0].url).toBe("http://hl7.org/fhir/StructureDefinition/match-grade");
    expect(twinEntry.search.extension[0].valueCode).toBe("certain");
    expect(twinEntry.search.score).toBeGreaterThan(0.9);
    expect(byId.has(typo)).toBe(true);
    expect(byId.has(other)).toBe(false);
  });

  it("is sorted by descending confidence (twin before typo)", async () => {
    const seed = { resourceType: "Patient", name: [{ family: "Nakamura", given: ["Yuki"] }], birthDate: "1990-06-15", gender: "female", address: [{ postalCode: "98101" }], telecom: [{ system: "phone", value: "206-555-0142" }] };
    const b = await (await match(seed)).json();
    const ids = (b.entry ?? []).map((e: any) => e.resource.id);
    expect(ids.indexOf(twin)).toBeLessThan(ids.indexOf(typo));
  });

  it("onlyCertainMatches=true drops the probable typo variant", async () => {
    const seed = { resourceType: "Patient", name: [{ family: "Nakamura", given: ["Yuki"] }], birthDate: "1990-06-15", gender: "female", address: [{ postalCode: "98101" }] };
    const b = await (await match(seed, [{ name: "onlyCertainMatches", valueBoolean: true }])).json();
    const grades = (b.entry ?? []).map((e: any) => e.search.extension[0].valueCode);
    expect(grades.every((g: string) => g === "certain")).toBe(true);
  });

  it("count caps the number of matches returned", async () => {
    const seed = { resourceType: "Patient", name: [{ family: "Nakamura", given: ["Yuki"] }], birthDate: "1990-06-15", gender: "female", address: [{ postalCode: "98101" }] };
    const b = await (await match(seed, [{ name: "count", valueInteger: 1 }])).json();
    expect((b.entry ?? []).length).toBeLessThanOrEqual(1);
  });

  it("400s a body that is not Parameters-with-a-Patient", async () => {
    expect((await req("POST", "/Patient/$match", { resourceType: "Patient" })).status).toBe(400);
    expect((await req("POST", "/Patient/$match", { resourceType: "Parameters", parameter: [] })).status).toBe(400);
  });

  it("returns an empty searchset when nothing blocks/matches", async () => {
    const seed = { resourceType: "Patient", name: [{ family: "Zzyzxqqq", given: ["Nomatch"] }], birthDate: "1901-01-01", gender: "male", address: [{ postalCode: "00000" }] };
    const b = await (await match(seed)).json();
    expect(b.total).toBe(0);
    expect(b.entry ?? []).toHaveLength(0);
  });
});
