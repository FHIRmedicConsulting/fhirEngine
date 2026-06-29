/**
 * Standalone OSS-Delta vertical slice — full CRUD + identifier search over HTTP
 * against the real DeltaWarehouse (delta-rs write / DataFusion read).
 *
 * Skipped unless RONIN_DELTA_SIDECAR_URL is set AND the sidecar is reachable
 * (mirrors the Databricks suite's credential gating). Start the sidecar first:
 *   python sidecar/delta_sidecar.py --port 8077 --base ./.delta-test
 * Run:
 *   RONIN_DELTA_SIDECAR_URL=http://127.0.0.1:8077 RONIN_DELTA_BASE=./.delta-test \
 *     npx vitest run tests/integration/delta-resource-flow.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("Standalone Delta resource flow (delta-rs + DataFusion)", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);

  // Unique id per run — Bronze is append-only, so isolate from prior runs.
  const pid = `t${Date.now()}`;
  const system = "urn:ronin:test";
  const value = `mrn-${pid}`;

  const patient = () => ({
    resourceType: "Patient",
    id: pid,
    identifier: [{ system, value, type: { coding: [{ code: "MR" }] } }],
    gender: "female",
    birthDate: "1990-01-01",
  });

  beforeAll(async () => {
    if (!SIDECAR) return;
    const ok = await wh.health();
    if (!ok) throw new Error(`delta sidecar not reachable at ${SIDECAR}`);
  });

  const req = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    app.fetch(
      new Request(`http://test${path}`, {
        method,
        headers: { "Content-Type": "application/fhir+json", ...(headers ?? {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );

  it("creates a Patient (201) on delta-rs", async () => {
    const res = await req("POST", "/Patient", patient());
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe(pid);
    expect(json.meta.versionId).toBe("1");
  });

  it("reads it back (200) via DataFusion", async () => {
    const res = await req("GET", `/Patient/${pid}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(pid);
    expect(json.gender).toBe("female");
    expect(json.birthDate).toBe("1990-01-01");
  });

  it("404s an unknown id", async () => {
    const res = await req("GET", `/Patient/does-not-exist-${pid}`);
    expect(res.status).toBe(404);
  });

  it("finds it by identifier (unnest-subquery search)", async () => {
    const res = await req("GET", `/Patient?identifier=${encodeURIComponent(`${system}|${value}`)}`);
    expect(res.status).toBe(200);
    const bundle = await res.json();
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.total).toBe(1);
    expect(bundle.entry[0].resource.id).toBe(pid);
  });

  it("updates with If-Match → version 2", async () => {
    const updated = { ...patient(), gender: "male" };
    const res = await req("PUT", `/Patient/${pid}`, updated, { "If-Match": 'W/"1"' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.meta.versionId).toBe("2");
    expect(json.gender).toBe("male");
  });

  it("rejects a stale If-Match (412)", async () => {
    const res = await req("PUT", `/Patient/${pid}`, patient(), { "If-Match": 'W/"1"' });
    expect(res.status).toBe(412);
  });

  it("soft-deletes (204) then reads 410", async () => {
    const del = await req("DELETE", `/Patient/${pid}`);
    expect(del.status).toBe(204);
    const res = await req("GET", `/Patient/${pid}`);
    expect(res.status).toBe(410);
  });

  it("validates resourceType mismatch (400)", async () => {
    const res = await req("POST", "/Patient", { resourceType: "Observation", id: "x" });
    expect(res.status).toBe(400);
  });
});
