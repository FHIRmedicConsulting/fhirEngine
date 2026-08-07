/**
 * SLS end-to-end (ADR-0015 A2): UNLABELED resources carrying sensitive clinical codes are
 * auto-labeled at ingest (Bronze body carries meta.security), and the already-shipped consent
 * gate then enforces on those labels — the full classify→store→enforce chain with no
 * source-supplied labels anywhere. Gated on sidecar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { configureSls, resetSls } from "../../src/security/sls.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const ts = Date.now();
const BASE = `${process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test"}-sls-${ts}`;
const ENV = ["FHIRENGINE_AUTH_ENABLED", "FHIRENGINE_AUTH_STRATEGY", "FHIRENGINE_CONSENT_ENFORCEMENT", "FHIRENGINE_SLS_ENABLED"];

describe.skipIf(!SIDECAR)("SLS auto-labeling → consent enforcement", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  let app: ReturnType<typeof createDeltaApp>;
  const req = (m: string, p: string, token: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json", Authorization: `Bearer ${token}` }, body: b ? JSON.stringify(b) : undefined }));

  const hiv = `hiv${ts}`, sud = `sud${ts}`, plain = `pl${ts}`;

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    process.env.FHIRENGINE_AUTH_ENABLED = "true";
    process.env.FHIRENGINE_AUTH_STRATEGY = "stub";
    process.env.FHIRENGINE_CONSENT_ENFORCEMENT = "true";
    process.env.FHIRENGINE_SLS_ENABLED = "true";
    await configureSls(wh); // demo baseline
    app = createDeltaApp({ warehouse: wh, baseUrl: "http://test" });
    const subject = { reference: "Patient/patient-jane-doe-fhir-id" };
    // NO meta.security anywhere in the inputs — labels must come from the SLS.
    await req("POST", "/Condition", "stub-system-all", {
      resourceType: "Condition", id: hiv, subject,
      code: { coding: [{ system: "http://snomed.info/sct", code: "86406008" }] },
    });
    await req("POST", "/Condition", "stub-system-all", {
      resourceType: "Condition", id: sud, subject,
      code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "F11.20" }] },
    });
    await req("POST", "/Condition", "stub-system-all", {
      resourceType: "Condition", id: plain, subject,
      code: { coding: [{ system: "http://snomed.info/sct", code: "38341003" }] }, // hypertension
    });
  });
  afterAll(() => { for (const k of ENV) delete process.env[k]; resetSls(); });

  it("stores SLS labels in the served body (classify at ingest, not at read)", async () => {
    const body = await (await req("GET", `/Condition/${hiv}`, "stub-system-all")).json();
    const labels = body.meta?.security ?? [];
    expect(labels.some((l: any) => l.code === "HIV")).toBe(true);
    expect(labels.some((l: any) => l.code === "R")).toBe(true);
  });

  it("the consent gate enforces on auto-applied labels: user-context 403s HIV + SUD, reads plain", async () => {
    expect((await req("GET", `/Condition/${hiv}`, "stub-user-rs")).status).toBe(403);
    expect((await req("GET", `/Condition/${sud}`, "stub-user-rs")).status).toBe(403);
    expect((await req("GET", `/Condition/${plain}`, "stub-user-rs")).status).toBe(200);
  });

  it("search filtering drops auto-labeled resources for user-context callers", async () => {
    const b = await (await req("GET", "/Condition?subject=Patient/patient-jane-doe-fhir-id", "stub-user-rs")).json();
    const ids = (b.entry ?? []).map((e: any) => e.resource.id);
    expect(ids).toContain(plain);
    expect(ids).not.toContain(hiv);
    expect(ids).not.toContain(sud);
  });

  it("system-context reads everything (administrative access unchanged)", async () => {
    expect((await req("GET", `/Condition/${hiv}`, "stub-system-all")).status).toBe(200);
  });

  it("unlabeled-code resources stay unlabeled (no over-classification)", async () => {
    const body = await (await req("GET", `/Condition/${plain}`, "stub-system-all")).json();
    expect(body.meta?.security ?? []).toEqual([]);
  });
});
