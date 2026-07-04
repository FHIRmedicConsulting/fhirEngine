/**
 * Terminology load + $validate-code over the Delta-backed store (pure-local DataFusion).
 * Loads real R4 Core administrative-gender CodeSystem + ValueSet, then validates codes.
 * Gated on FHIRENGINE_DELTA_SIDECAR_URL:
 *   python sidecar/delta_sidecar.py --port 8078 --base ./.delta-test
 *   R4_CORE=... FHIRENGINE_DELTA_SIDECAR_URL=http://127.0.0.1:8078 FHIRENGINE_DELTA_BASE=./.delta-test \
 *     npx vitest run tests/integration/delta-terminology.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { loadTerminologyResources } from "../../src/terminology/terminology-loader.js";
import { validateCode } from "../../src/terminology/validate-code.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test";
const R4 = process.env.R4_CORE ?? `${process.env.HOME}/.fhir/packages/hl7.fhir.r4.core#4.0.1/package`;

const CS_URL = "http://hl7.org/fhir/administrative-gender";
const VS_URL = "http://hl7.org/fhir/ValueSet/administrative-gender";

describe.skipIf(!SIDECAR)("Terminology load + $validate-code (pure-local)", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error(`sidecar not reachable at ${SIDECAR}`);
    const cs = JSON.parse(readFileSync(`${R4}/CodeSystem-administrative-gender.json`, "utf8"));
    const vs = JSON.parse(readFileSync(`${R4}/ValueSet-administrative-gender.json`, "utf8"));
    const res = await loadTerminologyResources(wh, [cs, vs], "overwrite");
    expect(res.concepts).toBe(4);
    expect(res.expansions).toBe(4); // VS includes the whole CodeSystem
  });

  it("validates a code in a ValueSet expansion", async () => {
    const ok = await validateCode(wh, { valueSet: VS_URL, code: "female" });
    expect(ok.result).toBe(true);
    expect(ok.display).toBeTruthy();
  });

  it("rejects a code not in the ValueSet", async () => {
    const bad = await validateCode(wh, { valueSet: VS_URL, code: "banana" });
    expect(bad.result).toBe(false);
  });

  it("validates a code against its CodeSystem", async () => {
    const ok = await validateCode(wh, { system: CS_URL, code: "male" });
    expect(ok.result).toBe(true);
    const bad = await validateCode(wh, { system: CS_URL, code: "nope" });
    expect(bad.result).toBe(false);
  });
});
