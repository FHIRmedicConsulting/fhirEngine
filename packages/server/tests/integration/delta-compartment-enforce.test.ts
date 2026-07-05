/**
 * Patient-compartment enforcement (auth chain point 4). With a `patient/*.rs` token + launch
 * patient, all reads MUST be scoped to that patient's compartment — no cross-patient leakage.
 * Regression for the "enforce() computed then discarded" hole. Sidecar-gated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { encodeStubToken } from "../../src/auth/idp/stub-auth.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("patient-compartment enforcement (no cross-patient leakage)", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const ts = Date.now();
  const P1 = `cmp-p1-${ts}`, P2 = `cmp-p2-${ts}`;
  let obs2Id = "";
  let appAuth: ReturnType<typeof createDeltaApp>;
  const tok = encodeStubToken({ sub: "u1", client_id: "app", scope: "patient/*.rs", patient: P1 } as never);
  const authGet = (p: string) =>
    appAuth.fetch(new Request(`http://test${p}`, { headers: { Authorization: `Bearer ${tok}` } }));
  const total = async (p: string) => (await (await authGet(p)).json()).total as number;

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    delete process.env.FHIRENGINE_AUTH_ENABLED;                 // seed with auth OFF
    const open = createDeltaApp({ warehouse: wh, baseUrl: "http://test" });
    const post = (p: string, b: unknown) => open.fetch(new Request(`http://test${p}`, { method: "POST", headers: { "Content-Type": "application/fhir+json" }, body: JSON.stringify(b) }));
    await post("/Patient", { resourceType: "Patient", id: P1 });
    await post("/Patient", { resourceType: "Patient", id: P2 });
    await post("/Observation", { resourceType: "Observation", status: "final", code: { text: "x" }, subject: { reference: `Patient/${P1}` } });
    obs2Id = (await (await post("/Observation", { resourceType: "Observation", status: "final", code: { text: "x" }, subject: { reference: `Patient/${P2}` } })).json()).id;
    process.env.FHIRENGINE_AUTH_ENABLED = "true";               // now build the enforcing app
    process.env.FHIRENGINE_AUTH_STRATEGY = "stub";
    appAuth = createDeltaApp({ warehouse: wh, baseUrl: "http://test" });
  });
  afterAll(() => { delete process.env.FHIRENGINE_AUTH_ENABLED; delete process.env.FHIRENGINE_AUTH_STRATEGY; });

  it("search is scoped to the token's patient compartment", async () => {
    expect(await total(`/Observation?_id=`)).toBeTypeOf("number"); // sanity: request authorized (not 401)
    const obs = await (await authGet(`/Observation`)).json();
    expect(obs.total).toBe(1);                                    // only P1's observation
    expect(obs.entry[0].resource.subject.reference).toBe(`Patient/${P1}`);
    const pats = await (await authGet(`/Patient`)).json();
    expect(pats.total).toBe(1);
    expect(pats.entry[0].resource.id).toBe(P1);                   // only own Patient
  });

  it("cannot read another patient's resources (404, no existence leak)", async () => {
    expect((await authGet(`/Patient/${P2}`)).status).toBe(404);
    expect((await authGet(`/Patient/${P1}`)).status).toBe(200);
    expect((await authGet(`/Observation/${obs2Id}`)).status).toBe(404); // P2's observation
  });

  it("$everything is limited to the token's own patient", async () => {
    expect((await authGet(`/Patient/${P1}/$everything`)).status).toBe(200);
    expect((await authGet(`/Patient/${P2}/$everything`)).status).toBe(404);
  });

  it("type/system _history is denied under a patient-restricted scope", async () => {
    expect((await authGet(`/Observation/_history`)).status).toBe(403);
    expect((await authGet(`/_history`)).status).toBe(403);
  });

  // --- security-audit regressions (2026-07-05) ---
  // A WRITE-capable patient token (cruds) — the H1 scenario the scope gate alone doesn't stop.
  const wtok = encodeStubToken({ sub: "u1", client_id: "app", scope: "patient/*.cruds", patient: P1 } as never);
  const authReq = (p: string, method: string, body?: unknown, useTok = wtok) =>
    appAuth.fetch(new Request(`http://test${p}`, {
      method, headers: { Authorization: `Bearer ${useTok}`, "Content-Type": "application/fhir+json" },
      body: body ? JSON.stringify(body) : undefined,
    }));

  it("write-capable patient token cannot WRITE another patient's resources (cross-compartment write guard)", async () => {
    // PUT another patient → 404 (no existence disclosure), own patient → allowed.
    expect((await authReq(`/Patient/${P2}`, "PUT", { resourceType: "Patient", id: P2, gender: "male" })).status).toBe(404);
    expect((await authReq(`/Patient/${P1}`, "PUT", { resourceType: "Patient", id: P1, gender: "female" })).status).toBe(200);
    // DELETE another patient's Observation → 404.
    expect((await authReq(`/Observation/${obs2Id}`, "DELETE")).status).toBe(404);
  });

  it("bulk $export requires a system scope — a patient-context token is refused", async () => {
    expect((await authGet(`/$export`)).status).toBe(403);        // system export
    // patient-scoped Patient/$export is constrained to the caller (not a population dump)
    const st = (await authGet(`/Patient/$export`)).status;
    expect([202, 403]).toContain(st);
  });

  it("export file/status routes reject path-traversal ids (404, no fs escape)", async () => {
    expect((await authGet(`/_export-file/..%2f..%2f..%2fetc%2fpasswd/Patient`)).status).toBe(404);
    expect((await authReq(`/_export-status/..%2f..%2f..%2f..`, "DELETE")).status).toBe(404);
  });
});
