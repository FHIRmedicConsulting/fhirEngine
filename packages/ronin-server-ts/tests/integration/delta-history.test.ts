/**
 * REST surface — instance _history + vread (version read), off the versioned store.
 * Gated on RONIN_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: _history + vread", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const id = `h${Date.now()}`;
  const req = (m: string, p: string, b?: unknown, h?: Record<string, string>) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json", ...(h ?? {}) }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    await req("POST", "/Patient", { resourceType: "Patient", id, name: [{ family: "V1" }] });
    await req("PUT", `/Patient/${id}`, { resourceType: "Patient", id, name: [{ family: "V2" }] }, { "If-Match": 'W/"1"' });
  });

  it("returns instance history (newest-first, 2 versions)", async () => {
    const res = await req("GET", `/Patient/${id}/_history`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.type).toBe("history");
    expect(b.total).toBe(2);
    expect(b.entry[0].resource.meta.versionId).toBe("2"); // newest first
  });

  it("vreads a specific version", async () => {
    const v1 = await (await req("GET", `/Patient/${id}/_history/1`)).json();
    expect(v1.name[0].family).toBe("V1");
    const v2 = await (await req("GET", `/Patient/${id}/_history/2`)).json();
    expect(v2.name[0].family).toBe("V2");
  });

  it("404s an unknown version", async () => {
    expect((await req("GET", `/Patient/${id}/_history/99`)).status).toBe(404);
  });

  it("includes the delete tombstone in history; vread of it is 410", async () => {
    expect((await req("DELETE", `/Patient/${id}`)).status).toBe(204);
    const b = await (await req("GET", `/Patient/${id}/_history`)).json();
    expect(b.total).toBe(3);
    expect(b.entry[0].request.method).toBe("DELETE");
    expect((await req("GET", `/Patient/${id}/_history/3`)).status).toBe(410);
  });
});
