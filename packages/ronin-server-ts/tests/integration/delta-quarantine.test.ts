/**
 * Quarantine-on-unknown-terminology + reconcile. Opt-in (RONIN_QUARANTINE_ON_UNKNOWN):
 * a resource binding a not-loaded ValueSet is quarantined (wait-for-terminology), then the
 * reconciler pulls the missing VSAC set + re-validates + ingests. Uses an isolated base so
 * no terminology is pre-loaded (gender's ValueSet is therefore "unknown"). Gated on sidecar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { reconcileTerminology } from "../../src/terminology/reconcile.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const ts = Date.now();
const BASE = `${process.env.RONIN_DELTA_BASE ?? "./.delta-test"}-q-${ts}`; // isolated: nothing pre-loaded

describe.skipIf(!SIDECAR)("quarantine-on-unknown + reconcile", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    process.env.RONIN_DISABLE_AUTO_RECONCILE = "true"; // deterministic: reconcile explicitly
  });
  afterAll(() => { delete process.env.RONIN_DISABLE_AUTO_RECONCILE; delete process.env.RONIN_QUARANTINE_ON_UNKNOWN; delete process.env.UMLS_API_KEY; });

  it("default (off): unknown ValueSet passes gracefully (201)", async () => {
    delete process.env.RONIN_QUARANTINE_ON_UNKNOWN;
    const r = await req("POST", "/Patient", { resourceType: "Patient", id: `off${ts}`, gender: "male" });
    expect(r.status).toBe(201); // graceful default unchanged
  });

  it("on: unknown ValueSet → quarantined (422) + pending-terminology row", async () => {
    process.env.RONIN_QUARANTINE_ON_UNKNOWN = "true";
    const r = await req("POST", "/Patient", { resourceType: "Patient", id: `on${ts}`, gender: "male" });
    expect(r.status).toBe(422); // flagged as a bad record
    wh.registerPendingTerminology();
    const rows = await wh.query<{ resource_id: string; missing: string; status: string }>(
      "SELECT resource_id, missing, status FROM pending_terminology WHERE resource_id = ?", [`on${ts}`]);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("wait-for-terminology");
    expect(rows[0].missing).toContain("administrative-gender");
    delete process.env.RONIN_QUARANTINE_ON_UNKNOWN;
  });

  it("reconcile: pull missing VSAC set (mocked) + re-validate + ingest to Bronze", async () => {
    const id = `recon${ts}`;
    await wh.writePendingTerminology([{
      row_id: `rid${ts}`, resource_type: "Patient", resource_id: id, version_id: 1,
      last_updated: "1970-01-01T00:00:00.000Z", deleted: false,
      body_json: JSON.stringify({ resourceType: "Patient", id, name: [{ family: "Recon" }], meta: { versionId: "1" } }),
      missing: "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.test", status: "wait-for-terminology", queued_at: "1970-01-01T00:00:00.000Z",
    }]);
    process.env.UMLS_API_KEY = "TESTKEY"; // mock fetch never uses it; satisfies the key guard
    const mockFetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({ resourceType: "ValueSet", url: "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.test", expansion: { total: 1, contains: [{ system: "urn:x", code: "y", display: "z" }] } }),
    } as any)) as unknown as typeof fetch;

    const report = await reconcileTerminology(wh, { fetchImpl: mockFetch });
    expect(report.pulled.some((p) => p.valueSet.includes("2.16.test"))).toBe(true);
    expect(report.resolved).toBeGreaterThanOrEqual(1);
    expect((await req("GET", `/Patient/${id}`)).status).toBe(200); // ingested to Bronze
    const left = await wh.query<{ n: number }>("SELECT count(*) AS n FROM pending_terminology WHERE row_id = ?", [`rid${ts}`]);
    expect(Number(left[0].n)).toBe(0); // dequeued
  });
});
