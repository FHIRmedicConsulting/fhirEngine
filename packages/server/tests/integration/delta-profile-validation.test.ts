/**
 * Profile validation prior to Bronze — installed US Core profiles are ENFORCED.
 * A resource claiming meta.profile=us-core-patient that's valid base R4 but violates
 * the profile (missing required identifier) → 422 + dead-letter, NOT Bronze.
 * Gated on FHIRENGINE_DELTA_SIDECAR_URL (sidecar must read the conformance store):
 *   python sidecar/delta_sidecar.py --port 8081 --base ./.delta-test
 *   FHIRENGINE_DELTA_SIDECAR_URL=http://127.0.0.1:8081 FHIRENGINE_DELTA_BASE=./.delta-test \
 *     npx vitest run tests/integration/delta-profile-validation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { installIgPackage } from "../../src/conformance/ig-loader.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test";
const US_CORE = process.env.US_CORE_PKG ?? `${process.env.HOME}/.fhir/packages/hl7.fhir.us.core#6.1.0/package`;
const PROFILE = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient";
const canRun = !!SIDECAR && existsSync(US_CORE);

describe.skipIf(!canRun)("Profile validation (US Core enforced prior to Bronze)", () => {
  const wh = canRun ? new DeltaWarehouse({ sidecarUrl: SIDECAR!, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = canRun ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const run = `pv${Date.now()}`;

  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    process.env.FHIRENGINE_VALIDATION_PROFILES = "declared"; // these suites assert claimed-profile enforcement (opt-in since the base-only default)
    if (!canRun) return;
    if (!(await wh.health())) throw new Error(`sidecar not reachable at ${SIDECAR}`);
    await installIgPackage(wh, US_CORE, "hl7.fhir.us.core#6.1.0");
  });

  afterAll(() => { delete process.env.FHIRENGINE_VALIDATION_PROFILES; });

  it("rejects a us-core-patient missing required identifier (422, not Bronze)", async () => {
    const id = `${run}-bad`;
    const res = await req("POST", "/Patient", {
      resourceType: "Patient", id, meta: { profile: [PROFILE] },
      name: [{ family: "Test" }], gender: "female", // no identifier → violates US Core
    });
    expect(res.status).toBe(422);
    expect((await req("GET", `/Patient/${id}`)).status).toBe(404);
  });

  it("accepts a conformant us-core-patient (201)", async () => {
    const id = `${run}-good`;
    const res = await req("POST", "/Patient", {
      resourceType: "Patient", id, meta: { profile: [PROFILE] },
      identifier: [{ system: "urn:ronin:mrn", value: id }],
      name: [{ family: "Test", given: ["A"] }], gender: "female",
    });
    expect(res.status).toBe(201);
  });

  it("does NOT enforce US Core on a plain Patient (no profile claim)", async () => {
    const id = `${run}-plain`;
    const res = await req("POST", "/Patient", { resourceType: "Patient", id, gender: "male" });
    expect(res.status).toBe(201); // base R4 only — identifier not required
  });
});
