/**
 * FHIR terminology *operation* endpoints ($validate-code / $expand / $lookup) — exposing the
 * local Delta terminology store as a tx server. Seeds a tiny CodeSystem/ValueSet then exercises
 * the endpoints. Sidecar-gated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { loadTerminologyResources } from "../../src/terminology/terminology-loader.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test";
// Unique per run so this test is hermetic against other terminology tests sharing the base.
const CS = `http://example.org/cs-${Date.now()}`;
const VS = `http://example.org/vs-${Date.now()}`;

describe.skipIf(!SIDECAR)("terminology operation endpoints", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const get = async (p: string) => { const r = await app.fetch(new Request(`http://test${p}`)); return { status: r.status, body: await r.json() }; };
  const postParams = async (p: string, parameter: any[]) => {
    const r = await app.fetch(new Request(`http://test${p}`, { method: "POST", headers: { "Content-Type": "application/fhir+json" }, body: JSON.stringify({ resourceType: "Parameters", parameter }) }));
    return { status: r.status, body: await r.json() };
  };
  const val = (params: any[], name: string) => params.find((x) => x.name === name);

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    // Seed via the real loader so the terminology-table schema matches the other terminology tests
    // sharing this base (raw minimal rows would corrupt the shared schema).
    const concepts = [{ code: "A", display: "Alpha" }, { code: "B", display: "Beta" }, { code: "C", display: "Gamma" }];
    await loadTerminologyResources(wh, [
      { resourceType: "CodeSystem", url: CS, version: "1.0.0", content: "complete", concept: concepts },
      { resourceType: "ValueSet", url: VS, version: "1.0.0", compose: { include: [{ system: CS, concept: concepts }] } },
    ]);
  });

  it("CodeSystem/$validate-code: valid code → result true + display", async () => {
    const { status, body } = await get(`/CodeSystem/$validate-code?url=${encodeURIComponent(CS)}&code=A`);
    expect(status).toBe(200);
    expect(val(body.parameter, "result").valueBoolean).toBe(true);
    expect(val(body.parameter, "display").valueString).toBe("Alpha");
  });

  it("CodeSystem/$validate-code: code not in a LOADED system → result false + error issue", async () => {
    const { body } = await get(`/CodeSystem/$validate-code?url=${encodeURIComponent(CS)}&code=NOPE`);
    expect(val(body.parameter, "result").valueBoolean).toBe(false);
    expect(val(body.parameter, "issues").resource.issue[0].severity).toBe("error");
  });

  it("ValueSet/$validate-code: member code → true; unknown ValueSet → warning issue", async () => {
    const ok = await get(`/ValueSet/$validate-code?url=${encodeURIComponent(VS)}&system=${encodeURIComponent(CS)}&code=A`);
    expect(val(ok.body.parameter, "result").valueBoolean).toBe(true);
    const unknown = await get(`/ValueSet/$validate-code?url=${encodeURIComponent("http://example.org/not-loaded")}&code=X`);
    expect(val(unknown.body.parameter, "result").valueBoolean).toBe(false);
    expect(val(unknown.body.parameter, "issues").resource.issue[0].severity).toBe("warning"); // can't validate ≠ invalid
  });

  it("ValueSet/$validate-code accepts a codeableConcept (valid if ANY coding matches)", async () => {
    const { body } = await postParams("/ValueSet/$validate-code", [
      { name: "url", valueUri: VS },
      { name: "codeableConcept", valueCodeableConcept: { coding: [{ system: CS, code: "NOPE" }, { system: CS, code: "B" }] } },
    ]);
    expect(val(body.parameter, "result").valueBoolean).toBe(true);       // "B" matches
    expect(val(body.parameter, "code").valueCode).toBe("B");
  });

  it("ValueSet/$expand returns the expansion contents", async () => {
    const { body } = await get(`/ValueSet/$expand?url=${encodeURIComponent(VS)}`);
    expect(body.resourceType).toBe("ValueSet");
    expect(body.expansion.total).toBe(3);
    expect(body.expansion.contains).toContainEqual({ system: CS, code: "A", display: "Alpha" });
  });

  it("ValueSet/$expand supports count/offset paging + filter (total is the full count)", async () => {
    const page = (await get(`/ValueSet/$expand?url=${encodeURIComponent(VS)}&count=2`)).body;
    expect(page.expansion.total).toBe(3);           // full total, not the page size
    expect(page.expansion.contains.length).toBe(2); // page
    const page2 = (await get(`/ValueSet/$expand?url=${encodeURIComponent(VS)}&count=2&offset=2`)).body;
    expect(page2.expansion.contains.length).toBe(1);
    const filtered = (await get(`/ValueSet/$expand?url=${encodeURIComponent(VS)}&filter=bet`)).body;
    expect(filtered.expansion.total).toBe(1);       // only "Beta"
    expect(filtered.expansion.contains[0].code).toBe("B");
  });

  it("CodeSystem/$lookup returns the display", async () => {
    const { status, body } = await get(`/CodeSystem/$lookup?system=${encodeURIComponent(CS)}&code=A`);
    expect(status).toBe(200);
    expect(val(body.parameter, "display").valueString).toBe("Alpha");
  });

  it("/metadata advertises the terminology operations", async () => {
    const meta = (await get(`/metadata`)).body;
    const vs = meta.rest[0].resource.find((r: any) => r.type === "ValueSet");
    expect(vs.operation.map((o: any) => o.name)).toEqual(expect.arrayContaining(["expand", "validate-code"]));
  });

  it("$versions reports the supported FHIR versions (tx client connect probe)", async () => {
    const { status, body } = await get(`/$versions?_format=json`);
    expect(status).toBe(200);
    expect(body.resourceType).toBe("Parameters");
    // Both R4 (the REST tier) and R5 (the tx battery's native version — R4
    // round-trips drop R5 expansion fields) are offered; R5 is the default so
    // tx-ecosystem clients speak R5 to the terminology endpoints.
    const versions = body.parameter.filter((p: any) => p.name === "version").map((p: any) => p.valueCode);
    expect(versions).toEqual(expect.arrayContaining(["4.0.1", "5.0.0"]));
    // Ecosystem clients (TxTester/validator) read `default` as valueString.
    expect(val(body.parameter, "default").valueString).toBe("5.0.0");
  });
});
