/**
 * REST surface — Patient/$everything (patient + compartment members). Gated on sidecar.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: Patient/$everything", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const pid = `pe${ts}`;
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    await req("POST", "/Patient", { resourceType: "Patient", id: pid, name: [{ family: "Every" }] });
    await req("POST", "/Observation", { resourceType: "Observation", id: `o1${ts}`, status: "final", code: { text: "bp" }, subject: { reference: `Patient/${pid}` } });
    await req("POST", "/Observation", { resourceType: "Observation", id: `o2${ts}`, status: "final", code: { text: "hr" }, subject: { reference: `Patient/${pid}` } });
    await req("POST", "/Condition", { resourceType: "Condition", id: `c1${ts}`, code: { text: "dx" }, subject: { reference: `Patient/${pid}` } });
    await req("POST", "/Observation", { resourceType: "Observation", id: `ox${ts}`, status: "final", code: { text: "x" }, subject: { reference: `Patient/other${ts}` } });
  });

  const refsOf = async (method: string) => {
    const b = await (await req(method, `/Patient/${pid}/$everything`)).json();
    expect(b.type).toBe("searchset");
    return new Set<string>(b.entry.map((e: any) => `${e.resource.resourceType}/${e.resource.id}`));
  };

  it("includes the patient + compartment members (via subject AND patient params), excludes others", async () => {
    const refs = await refsOf("GET");
    expect(refs.has(`Patient/${pid}`)).toBe(true);
    expect(refs.has(`Observation/o1${ts}`)).toBe(true);
    expect(refs.has(`Observation/o2${ts}`)).toBe(true);
    expect(refs.has(`Condition/c1${ts}`)).toBe(true); // Condition links via "patient" → Condition.subject
    expect(refs.has(`Observation/ox${ts}`)).toBe(false); // references a different patient
  });

  it("supports POST form", async () => {
    const refs = await refsOf("POST");
    expect(refs.has(`Patient/${pid}`)).toBe(true);
    expect(refs.has(`Condition/c1${ts}`)).toBe(true);
  });

  it("404s $everything on an unknown patient", async () => {
    expect((await req("GET", `/Patient/missing${ts}/$everything`)).status).toBe(404);
  });

  // Feature-completeness: $everything now paginates (_count/_getpagesoffset + next link) and
  // honors _since (both were previously missing — one unbounded bundle, _since ignored).
  it("paginates with _count + emits a next link; total is the full compartment", async () => {
    const b1 = await (await req("GET", `/Patient/${pid}/$everything?_count=2`)).json();
    expect(b1.total).toBe(4); // patient + 2 Observation + 1 Condition
    expect(b1.entry.length).toBe(2);
    expect(b1.link.some((l: any) => l.relation === "next")).toBe(true);
    const b2 = await (await req("GET", `/Patient/${pid}/$everything?_count=2&_getpagesoffset=2`)).json();
    expect(b2.entry.length).toBe(2);
    expect(b2.link.some((l: any) => l.relation === "next")).toBe(false); // last page
  });

  it("honors _since (a future _since returns nothing)", async () => {
    const b = await (await req("GET", `/Patient/${pid}/$everything?_since=2099-01-01`)).json();
    expect(b.total).toBe(0);
  });
});
