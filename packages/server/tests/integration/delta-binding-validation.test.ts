/**
 * L3 terminology-binding validation prior to Bronze. A code that's structurally valid
 * but NOT in a required binding's ValueSet → 422 + dead-letter (the case structural
 * validation alone can't catch). Graceful: if the ValueSet isn't loaded, it's skipped.
 * Gated on FHIRENGINE_DELTA_SIDECAR_URL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { loadTerminologyResources } from "../../src/terminology/terminology-loader.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test";
const R4 = process.env.R4_CORE ?? `${process.env.HOME}/.fhir/packages/hl7.fhir.r4.core#4.0.1/package`;
const canRun = !!SIDECAR && existsSync(R4);

describe.skipIf(!canRun)("L3 binding validation (required ValueSet, prior to Bronze)", () => {
  const wh = canRun ? new DeltaWarehouse({ sidecarUrl: SIDECAR!, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = canRun ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const run = `bv${Date.now()}`;
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (!canRun) return;
    if (!(await wh.health())) throw new Error(`sidecar not reachable at ${SIDECAR}`);
    // administrative-gender (code binding, Patient.gender) + allergyintolerance-clinical
    // (CodeableConcept binding, AllergyIntolerance.clinicalStatus).
    const load = (f: string) => JSON.parse(readFileSync(`${R4}/${f}.json`, "utf8"));
    await loadTerminologyResources(wh, [
      load("CodeSystem-administrative-gender"), load("ValueSet-administrative-gender"),
      load("CodeSystem-allergyintolerance-clinical"), load("ValueSet-allergyintolerance-clinical"),
    ], "overwrite");
  });

  const ALLERGY_SYS = "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";
  const allergy = (id: string, code: string) => ({
    resourceType: "AllergyIntolerance", id,
    clinicalStatus: { coding: [{ system: ALLERGY_SYS, code }] },
    patient: { reference: "Patient/x" }, // required
  });

  it("rejects a structurally-valid but out-of-binding code (422 → dead-letter)", async () => {
    const id = `${run}-bad`;
    // gender 'banana' passes structural (it's a valid `code` token) but fails the
    // required administrative-gender binding.
    const res = await req("POST", "/Patient", { resourceType: "Patient", id, gender: "banana" });
    expect(res.status).toBe(422);
    expect((await req("GET", `/Patient/${id}`)).status).toBe(404);
  });

  it("accepts an in-binding code", async () => {
    const id = `${run}-good`;
    const res = await req("POST", "/Patient", { resourceType: "Patient", id, gender: "female" });
    expect(res.status).toBe(201);
  });

  it("rejects a CodeableConcept with no coding in the required ValueSet (422)", async () => {
    const id = `${run}-cc-bad`;
    const res = await req("POST", "/AllergyIntolerance", allergy(id, "banana"));
    expect(res.status).toBe(422);
    expect((await req("GET", `/AllergyIntolerance/${id}`)).status).toBe(404);
  });

  it("accepts a CodeableConcept with an in-binding coding", async () => {
    const id = `${run}-cc-good`;
    const res = await req("POST", "/AllergyIntolerance", allergy(id, "active"));
    expect(res.status).toBe(201);
  });

  it("enforces FHIRPath invariants (L4) — pat-1: contact requires details", async () => {
    const bad = `${run}-inv-bad`;
    // contact has only gender (in-binding) but no name/telecom/address/organization → pat-1
    const r1 = await req("POST", "/Patient", { resourceType: "Patient", id: bad, contact: [{ gender: "female" }] });
    expect(r1.status).toBe(422);
  });

  it("catches a NESTED binding violation (Patient.contact.gender)", async () => {
    const bad = `${run}-nested-bad`;
    const r1 = await req("POST", "/Patient", {
      resourceType: "Patient", id: bad, contact: [{ gender: "banana", name: { family: "C" } }],
    });
    expect(r1.status).toBe(422);
    const good = `${run}-nested-good`;
    const r2 = await req("POST", "/Patient", {
      resourceType: "Patient", id: good, contact: [{ gender: "female", name: { family: "C" } }],
    });
    expect(r2.status).toBe(201);
  });
});
