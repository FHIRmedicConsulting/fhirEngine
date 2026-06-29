/**
 * REST surface — accurate CapabilityStatement (/metadata) + $validate operation
 * (instance + system-level). Gated on RONIN_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: /metadata + $validate", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (SIDECAR && !(await wh.health())) throw new Error("sidecar down");
  });

  it("serves an accurate CapabilityStatement", async () => {
    const cs = await (await req("GET", "/metadata")).json();
    expect(cs.resourceType).toBe("CapabilityStatement");
    expect(cs.fhirVersion).toBe("4.0.1");
    const patient = cs.rest[0].resource.find((r: any) => r.type === "Patient");
    const codes = patient.interaction.map((i: any) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["read", "vread", "create", "update", "delete", "search-type", "history-instance"]));
    expect(cs.rest[0].operation.some((o: any) => o.name === "validate")).toBe(true);
  });

  it("$validate returns a success OperationOutcome for a valid resource", async () => {
    const res = await req("POST", "/Patient/$validate", { resourceType: "Patient", name: [{ family: "OK" }] });
    expect(res.status).toBe(200);
    const oo = await res.json();
    expect(oo.resourceType).toBe("OperationOutcome");
    expect(oo.issue[0].severity).toBe("information");
  });

  it("$validate flags an invalid resource (pat-1) with HTTP 200 + error issue (no persist)", async () => {
    const res = await req("POST", "/Patient/$validate", { resourceType: "Patient", contact: [{ gender: "female" }] });
    expect(res.status).toBe(200);
    const oo = await res.json();
    expect(oo.issue.some((i: any) => i.severity === "error")).toBe(true);
  });

  it("system-level $validate infers resourceType from the body", async () => {
    const oo = await (await req("POST", "/$validate", { resourceType: "Observation" })).json();
    expect(oo.resourceType).toBe("OperationOutcome");
    expect(oo.issue.some((i: any) => i.severity === "error")).toBe(true); // missing status/code
  });
});
