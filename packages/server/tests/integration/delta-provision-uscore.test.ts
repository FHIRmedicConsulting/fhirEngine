/**
 * Provision US Core 6.1.0 ON TOP OF FHIR R4 Core, then validate against the stack.
 * Layered install (R4 Core baseline → US Core IG) + enforcement. Gated on the sidecar:
 *   python sidecar/delta_sidecar.py --port 8083 --base ./.delta-test
 *   FHIRENGINE_DELTA_SIDECAR_URL=http://127.0.0.1:8083 FHIRENGINE_DELTA_BASE=./.delta-test \
 *     npx vitest run tests/integration/delta-provision-uscore.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { installIgPackage, isProfileInstalled, listInstalledProfiles } from "../../src/conformance/ig-loader.js";
import { validateCode } from "../../src/terminology/validate-code.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test";
const R4 = process.env.R4_CORE ?? `${process.env.HOME}/.fhir/packages/hl7.fhir.r4.core#4.0.1/package`;
const US_CORE = process.env.US_CORE_PKG ?? `${process.env.HOME}/.fhir/packages/hl7.fhir.us.core#6.1.0/package`;
const US_CORE_PATIENT = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient";
const canRun = !!SIDECAR && existsSync(R4) && existsSync(US_CORE);

describe.skipIf(!canRun)("Provision US Core 6.1.0 on R4 Core + validate", () => {
  const wh = canRun ? new DeltaWarehouse({ sidecarUrl: SIDECAR!, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = canRun ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const run = `us${Date.now()}`;
  let r4Result: any, usResult: any;

  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    process.env.FHIRENGINE_VALIDATION_PROFILES = "declared"; // these suites assert claimed-profile enforcement (opt-in since the base-only default)
    if (!canRun) return;
    if (!(await wh.health())) throw new Error(`sidecar not reachable at ${SIDECAR}`);
    r4Result = await installIgPackage(wh, R4, "hl7.fhir.r4.core#4.0.1");        // baseline
    usResult = await installIgPackage(wh, US_CORE, "hl7.fhir.us.core#6.1.0");   // on top
    console.log("R4 Core:", JSON.stringify(r4Result));
    console.log("US Core:", JSON.stringify(usResult));
  }, 180_000);

  it("installs R4 Core baseline (StructureDefinitions + terminology)", async () => {
    expect(r4Result.profiles + r4Result.extensions).toBeGreaterThan(0);
    expect(r4Result.valueSets).toBeGreaterThan(100);
    // R4 Core terminology resolves locally:
    const g = await validateCode(wh, { valueSet: "http://hl7.org/fhir/ValueSet/administrative-gender", code: "female" });
    expect(g.result).toBe(true);
  });

  afterAll(() => { delete process.env.FHIRENGINE_VALIDATION_PROFILES; });

  it("installs US Core 6.1.0 on top (profiles resolvable)", async () => {
    expect(usResult.profiles).toBeGreaterThan(10);
    expect(await isProfileInstalled(wh, US_CORE_PATIENT)).toBe(true);
    const profiles = await listInstalledProfiles(wh);
    expect(profiles.some((p) => p.url === US_CORE_PATIENT)).toBe(true);
  });

  it("enforces us-core-patient against the provisioned stack", async () => {
    // conformant → Bronze
    const goodId = `${run}-good`;
    const good = await req("POST", "/Patient", {
      resourceType: "Patient", id: goodId, meta: { profile: [US_CORE_PATIENT] },
      identifier: [{ system: "urn:ronin:mrn", value: goodId }],
      name: [{ family: "Provision", given: ["A"] }], gender: "female",
    });
    expect(good.status).toBe(201);

    // non-conformant (missing required identifier) → 422, dead-letter, not Bronze
    const badId = `${run}-bad`;
    const bad = await req("POST", "/Patient", {
      resourceType: "Patient", id: badId, meta: { profile: [US_CORE_PATIENT] },
      name: [{ family: "Bad" }], gender: "male",
    });
    expect(bad.status).toBe(422);
    expect((await req("GET", `/Patient/${badId}`)).status).toBe(404);
  });
});
