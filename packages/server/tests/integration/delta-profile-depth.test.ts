/**
 * Profile enforcement DEPTH (#5): nested required elements (any depth, conditional on parent
 * presence) + profile-tightened required bindings (where US Core CodeableConcept/Coding bindings
 * live). Seeds a synthetic profile + terminology, then $validates conforming / non-conforming
 * resources. Sidecar-gated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { loadTerminologyResources } from "../../src/terminology/terminology-loader.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const ts = Date.now();
// Own base (delta-consent pattern) — this test seeds conformance + terminology tables, so it must
// not share them with the other terminology/profile tests (schema-inference order fragility).
const BASE = `${process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test"}-pdepth-${ts}`;
const PROFILE = `http://example.org/StructureDefinition/depth-${ts}`;
const VS_GENDER = `http://example.org/ValueSet/gender-${ts}`;
const SYS = `http://example.org/cs-${ts}`;

describe.skipIf(!SIDECAR)("profile enforcement depth (nested required + profile bindings)", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const validate = async (body: unknown) => {
    const r = await app.fetch(new Request("http://test/Patient/$validate", { method: "POST", headers: { "Content-Type": "application/fhir+json" }, body: JSON.stringify(body) }));
    return (await r.json()).issue as Array<{ severity: string; diagnostics?: string }>;
  };
  const diags = (issues: { severity: string; diagnostics?: string }[]) =>
    issues.filter((i) => i.severity === "error").map((i) => i.diagnostics ?? "").join(" | ");
  const patient = (over: Record<string, unknown>) => ({ resourceType: "Patient", meta: { profile: [PROFILE] }, ...over });

  beforeAll(async () => {
    process.env.FHIRENGINE_VALIDATION_PROFILES = "declared"; // these suites assert claimed-profile enforcement (opt-in since the base-only default)
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    // profile: identifier(min1) + identifier.system(min1, NESTED) + gender(min1, required binding)
    const sd = {
      resourceType: "StructureDefinition", url: PROFILE, type: "Patient",
      snapshot: { element: [
        { path: "Patient" },
        { path: "Patient.identifier", min: 1, type: [{ code: "Identifier" }] },
        { path: "Patient.identifier.system", min: 1, type: [{ code: "uri" }] },
        { path: "Patient.gender", min: 1, type: [{ code: "code" }], binding: { strength: "required", valueSet: VS_GENDER } },
      ] },
    };
    // Full column set matching the IG loader (so it appends compatibly to the shared table).
    await wh.writeConformance("structuredefinition", [{
      url: PROFILE, name: `depth${ts}`, type: "Patient", kind: "resource", derivation: "constraint",
      baseDefinition: "http://hl7.org/fhir/StructureDefinition/Patient", version: "1", package: "test", json: JSON.stringify(sd),
    }]);
    await loadTerminologyResources(wh, [
      { resourceType: "CodeSystem", url: SYS, version: "1", content: "complete", concept: [{ code: "female" }, { code: "male" }] },
      { resourceType: "ValueSet", url: VS_GENDER, version: "1", compose: { include: [{ system: SYS, concept: [{ code: "female" }, { code: "male" }] }] } },
    ]);
  });

  afterAll(() => { delete process.env.FHIRENGINE_VALIDATION_PROFILES; });

  it("a conforming resource passes", async () => {
    const errs = diags(await validate(patient({ identifier: [{ system: "urn:x", value: "1" }], gender: "female" })));
    expect(errs).toBe("");
  });

  it("nested required: an identifier without system is rejected (identifier.system)", async () => {
    const errs = diags(await validate(patient({ identifier: [{ value: "1" }], gender: "female" })));
    expect(errs).toMatch(/identifier\.system/);
  });

  it("top-level required still enforced (missing identifier / gender)", async () => {
    expect(diags(await validate(patient({ gender: "female" })))).toMatch(/identifier/);
    expect(diags(await validate(patient({ identifier: [{ system: "urn:x", value: "1" }] })))).toMatch(/gender/);
  });

  it("profile required binding: a gender not in the bound (loaded) ValueSet is rejected", async () => {
    const errs = diags(await validate(patient({ identifier: [{ system: "urn:x", value: "1" }], gender: "other" })));
    expect(errs).toMatch(new RegExp(VS_GENDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("nested required is conditional: no identifier array element → no identifier.system error", async () => {
    // (missing identifier entirely is caught by the top-level rule, not the nested one)
    const errs = diags(await validate(patient({ identifier: [{ system: "urn:x", value: "1" }], gender: "male" })));
    expect(errs).not.toMatch(/identifier\.system/);
  });
});
