/**
 * REST surface — batch / transaction Bundle processing + type-level _history.
 * Gated on RONIN_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: batch / transaction + type history", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (SIDECAR && !(await wh.health())) throw new Error("sidecar down");
  });

  it("processes a batch with independent per-entry responses", async () => {
    const res = await req("POST", "/", {
      resourceType: "Bundle",
      type: "batch",
      entry: [
        { request: { method: "POST", url: "Patient" }, resource: { resourceType: "Patient", id: `b${ts}`, name: [{ family: "Batch" }] } },
        { request: { method: "GET", url: `Patient/missing${ts}` } },
      ],
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.type).toBe("batch-response");
    expect(b.entry[0].response.status).toBe("201");
    expect(b.entry[0].response.location).toContain(`Patient/b${ts}`);
    expect(b.entry[1].response.status).toBe("404");
  });

  it("processes a transaction and resolves urn:uuid references", async () => {
    const u1 = `urn:uuid:${ts}-aaaa`;
    const res = await req("POST", "/", {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        { fullUrl: u1, request: { method: "POST", url: "Patient" }, resource: { resourceType: "Patient", name: [{ family: "Tx" }] } },
        { request: { method: "POST", url: "Observation" }, resource: { resourceType: "Observation", status: "final", code: { text: "bp" }, subject: { reference: u1 } } },
      ],
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.type).toBe("transaction-response");
    expect(b.entry[0].response.status).toBe("201");
    const obs = b.entry[1].resource;
    expect(obs.subject.reference).toMatch(/^Patient\//); // urn:uuid rewritten to the assigned id
    expect(obs.subject.reference).not.toContain("urn:uuid");
  });

  it("rejects an invalid transaction atomically (nothing written)", async () => {
    const goodId = `txok${ts}`;
    const res = await req("POST", "/", {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        { request: { method: "POST", url: "Patient" }, resource: { resourceType: "Patient", id: goodId, name: [{ family: "Good" }] } },
        { request: { method: "POST", url: "Observation" }, resource: { resourceType: "Observation" } }, // missing status+code
      ],
    });
    expect(res.status).toBe(422);
    expect((await req("GET", `/Patient/${goodId}`)).status).toBe(404); // good entry not written
  });

  it("returns type-level history", async () => {
    const b = await (await req("GET", "/Patient/_history?_count=100")).json();
    expect(b.type).toBe("history");
    expect(b.total).toBeGreaterThanOrEqual(1);
    expect(b.entry[0].request.method).toBeTruthy();
  });
});
