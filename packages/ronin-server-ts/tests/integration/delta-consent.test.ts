/**
 * Read-time consent + DS4P label enforcement (ADR-0030 controls #3/#4). Opt-in
 * (RONIN_CONSENT_ENFORCEMENT) + requires auth. Verifies: system allowed, user-context
 * blocked on Restricted/sensitive resources, patient-compartment isolation, search filtering.
 * Gated on sidecar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const ts = Date.now();
const BASE = `${process.env.RONIN_DELTA_BASE ?? "./.delta-test"}-consent-${ts}`;
const SENS = "http://terminology.hl7.org/CodeSystem/v3-ActCode";

describe.skipIf(!SIDECAR)("consent + DS4P label enforcement", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  let app: ReturnType<typeof createDeltaApp>;
  const req = (m: string, p: string, token: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json", Authorization: `Bearer ${token}` }, body: b ? JSON.stringify(b) : undefined }));

  // ids
  const normal = `n${ts}`, ethy = `e${ts}`;

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    process.env.RONIN_AUTH_ENABLED = "true";
    process.env.RONIN_AUTH_STRATEGY = "stub";
    process.env.RONIN_CONSENT_ENFORCEMENT = "true";
    app = createDeltaApp({ warehouse: wh, baseUrl: "http://test" });
    // create via system token (system/*.cruds): a normal Observation + a sensitivity-tagged one
    await req("POST", "/Observation", "stub-system-all", { resourceType: "Observation", id: normal, status: "final", code: { text: "bp" }, subject: { reference: "Patient/patient-jane-doe-fhir-id" } });
    await req("POST", "/Observation", "stub-system-all", { resourceType: "Observation", id: ethy, status: "final", code: { text: "sud" }, subject: { reference: "Patient/patient-jane-doe-fhir-id" }, meta: { security: [{ system: SENS, code: "ETH" }] } });
  });
  afterAll(() => { for (const k of ["RONIN_AUTH_ENABLED", "RONIN_AUTH_STRATEGY", "RONIN_CONSENT_ENFORCEMENT"]) delete process.env[k]; });

  it("system-context: reads both (administrative access)", async () => {
    expect((await req("GET", `/Observation/${normal}`, "stub-system-all")).status).toBe(200);
    expect((await req("GET", `/Observation/${ethy}`, "stub-system-all")).status).toBe(200);
  });

  it("user-context: reads normal, BLOCKED (403) on the sensitivity-tagged resource", async () => {
    expect((await req("GET", `/Observation/${normal}`, "stub-user-rs")).status).toBe(200);
    expect((await req("GET", `/Observation/${ethy}`, "stub-user-rs")).status).toBe(403);
  });

  it("user-context search: the sensitive resource is filtered out of the page", async () => {
    const b = await (await req("GET", "/Observation?subject=Patient/patient-jane-doe-fhir-id", "stub-user-rs")).json();
    const ids = b.entry?.map((e: any) => e.resource.id) ?? [];
    expect(ids).toContain(normal);
    expect(ids).not.toContain(ethy); // sensitivity-tagged → filtered
  });

  it("computable-consent override: a permit Consent grants the otherwise-blocked sensitive read", async () => {
    const pid = `pc${ts}`;
    const obsId = `co${ts}`;
    // sensitive Observation for a patient WITHOUT consent → user is blocked
    await req("POST", "/Observation", "stub-system-all", { resourceType: "Observation", id: obsId, status: "final", code: { text: "sud" }, subject: { reference: `Patient/${pid}` }, meta: { security: [{ system: SENS, code: "ETH" }] } });
    expect((await req("GET", `/Observation/${obsId}`, "stub-user-rs")).status).toBe(403);
    // add an active Consent permitting ETH (empty actor = applies to all) → now allowed
    const cres = await req("POST", "/Consent", "stub-system-all", {
      resourceType: "Consent", id: `cons${ts}`, status: "active",
      scope: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/consentscope", code: "patient-privacy" }] },
      category: [{ coding: [{ system: "http://loinc.org", code: "59284-0" }] }],
      policyRule: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/consentpolicycodes", code: "hipaa-auth" }] },
      patient: { reference: `Patient/${pid}` },
      provision: { type: "permit", securityLabel: [{ system: SENS, code: "ETH" }] },
    });
    expect(cres.status).toBe(201); // Consent stored (else the override can't find it)
    expect((await req("GET", `/Observation/${obsId}`, "stub-user-rs")).status).toBe(200);
  });

  it("patient-context: own compartment allowed, other patient denied", async () => {
    // stub-patient-jane → launch/patient = jane-doe; the Observations are in jane's compartment
    expect((await req("GET", `/Observation/${normal}`, "stub-patient-jane")).status).toBe(200);
    // a resource in another patient's compartment → denied
    await req("POST", "/Observation", "stub-system-all", { resourceType: "Observation", id: `o2${ts}`, status: "final", code: { text: "x" }, subject: { reference: "Patient/someone-else" } });
    expect((await req("GET", `/Observation/o2${ts}`, "stub-patient-jane")).status).toBe(403);
  });
});
