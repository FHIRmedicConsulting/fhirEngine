/**
 * Route-surface tests for $export with a stubbed warehouse (no Delta store): kickoff
 * semantics, the path-traversal guards in front of the job filesystem, and the
 * scope gate that keeps patient-context tokens from dumping the population.
 * (The full kickoff→poll→download flow against real data lives in
 * tests/integration/delta-bulk-history.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountExport } from "../../src/routes/export.js";
import { FhirError } from "../../src/lib/errors.js";
import type { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import type { AuthContext } from "../../src/auth/auth-context.js";
import type { CanonicalScope } from "../../src/auth/smart-versions/types.js";

const BASE = "https://fhir.example";
let dir: string;
let savedEnv: string | undefined;

beforeAll(() => {
  savedEnv = process.env.FHIRENGINE_EXPORT_DIR;
  dir = mkdtempSync(join(tmpdir(), "fhirengine-export-route-"));
  process.env.FHIRENGINE_EXPORT_DIR = dir;
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.FHIRENGINE_EXPORT_DIR;
  else process.env.FHIRENGINE_EXPORT_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

// No tables → the background runner finds nothing to export and completes immediately.
const wh = { hasTable: () => false } as unknown as DeltaWarehouse;

function makeApp(auth?: AuthContext): Hono {
  const app = new Hono();
  if (auth) app.use("*", async (c, next) => { c.set("auth" as never, auth as never); await next(); });
  app.onError((err, c) => {
    if (err instanceof FhirError) return c.json({ error: err.message }, err.status as 403);
    throw err;
  });
  mountExport(app, wh, BASE);
  return app;
}

function scope(context: CanonicalScope["context"], resourceType: string | null, operations: CanonicalScope["operations"]): CanonicalScope {
  return { context, resourceType, operations, queryRestrictions: {}, rawScope: "", parsedUnderVersion: "2.0" };
}

function auth(scopes: CanonicalScope[], launchPatientId: string | null = null): AuthContext {
  return {
    token: "t", subject: "s", clientId: "c", scopes, rawScopeString: "",
    launchPatientId, launchEncounterId: null, fhirUser: null, purposeOfUse: null,
    expiresAt: 0, issuer: "", parsedUnderSmartVersion: "2.0",
  };
}

async function pollComplete(app: Hono, statusUrl: string): Promise<Response> {
  for (let i = 0; i < 50; i++) {
    const res = await app.request(statusUrl);
    if (res.status !== 202) return res;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("export never completed");
}

describe("$export kickoff", () => {
  it("returns 202 with a Content-Location status URL; the job then completes", async () => {
    const app = makeApp();
    const res = await app.request("/$export");
    expect(res.status).toBe(202);
    const loc = res.headers.get("Content-Location")!;
    expect(loc).toMatch(new RegExp(`^${BASE}/_export-status/[0-9a-f-]{36}$`));

    const done = await pollComplete(app, loc.slice(BASE.length));
    expect(done.status).toBe(200);
    const manifest = await done.json();
    expect(manifest.request).toBe(`${BASE}/$export`);
    expect(manifest.output).toEqual([]);
  });

  it("rejects a non-ndjson _outputFormat with 400", async () => {
    const res = await makeApp().request("/$export?_outputFormat=application/fhir%2Bxml");
    expect(res.status).toBe(400);
  });

  it("BLOCKS a patient-context token from a system-wide export (403)", async () => {
    const patientToken = auth([scope("patient", "*", ["r", "s"])], "pat-42");
    const res = await makeApp(patientToken).request("/$export");
    expect(res.status).toBe(403);
  });

  it("BLOCKS a token with no read scope at all (fail closed, 403)", async () => {
    const res = await makeApp(auth([])).request("/$export");
    expect(res.status).toBe(403);
  });

  it("allows a system-scope token to run a system export", async () => {
    const res = await makeApp(auth([scope("system", "*", ["r", "s"])])).request("/$export");
    expect(res.status).toBe(202);
  });

  it("allows a patient-context token to export its OWN compartment via Patient/$export", async () => {
    const res = await makeApp(auth([scope("patient", "*", ["r", "s"])], "pat-42")).request("/Patient/$export");
    expect(res.status).toBe(202);
  });
});

describe("$export job endpoints reject hostile ids before the filesystem", () => {
  const app = makeApp();

  it("status: traversal-shaped jobId → 404", async () => {
    for (const bad of ["..%2F..%2Fetc", "..", "a".repeat(36), "0000000-0000-0000-0000-000000000000x"]) {
      const res = await app.request(`/_export-status/${bad}`);
      expect(res.status, `jobId=${bad}`).toBe(404);
    }
  });

  it("file: traversal-shaped jobId or type → 404", async () => {
    const okJob = "00000000-0000-7000-8000-000000000000";
    expect((await app.request(`/_export-file/..%2Fescape/Patient`)).status).toBe(404);
    expect((await app.request(`/_export-file/${okJob}/..%2Fmanifest.json`)).status).toBe(404);
    expect((await app.request(`/_export-file/${okJob}/Patient.ndjson`)).status).toBe(404); // dots rejected
  });

  it("delete: traversal-shaped jobId → 404, never touches the export dir", async () => {
    const res = await app.request("/_export-status/..%2F..", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("well-formed but unknown jobId → 404", async () => {
    expect((await app.request("/_export-status/00000000-0000-7000-8000-000000000000")).status).toBe(404);
  });
});

describe("$export cancellation", () => {
  it("DELETE removes the job; subsequent polls 404", async () => {
    const app = makeApp();
    const kick = await app.request("/$export");
    const statusPath = kick.headers.get("Content-Location")!.slice(BASE.length);
    await pollComplete(app, statusPath); // let the background runner finish before deleting

    expect((await app.request(statusPath, { method: "DELETE" })).status).toBe(202);
    expect((await app.request(statusPath)).status).toBe(404);
  });
});
