/**
 * IG-package install facility — installs real US Core 6.1.0 (profiles + terminology)
 * from the local FHIR package cache. Gated on RONIN_DELTA_SIDECAR_URL:
 *   python sidecar/delta_sidecar.py --port 8079 --base ./.delta-test
 *   RONIN_DELTA_SIDECAR_URL=http://127.0.0.1:8079 RONIN_DELTA_BASE=./.delta-test \
 *     npx vitest run tests/integration/delta-ig-install.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { installIgPackage, listInstalledProfiles, isProfileInstalled } from "../../src/conformance/ig-loader.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";
const US_CORE = process.env.US_CORE_PKG ?? "/Users/chad/.fhir/packages/hl7.fhir.us.core#6.1.0/package";
const US_CORE_PATIENT = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient";

const canRun = !!SIDECAR && existsSync(US_CORE);

describe.skipIf(!canRun)("IG-package install (US Core 6.1.0: profiles + terminology)", () => {
  const wh = canRun ? new DeltaWarehouse({ sidecarUrl: SIDECAR!, base: BASE }) : (null as unknown as DeltaWarehouse);

  beforeAll(async () => {
    if (!canRun) return;
    if (!(await wh.health())) throw new Error(`sidecar not reachable at ${SIDECAR}`);
    const res = await installIgPackage(wh, US_CORE, "hl7.fhir.us.core#6.1.0");
    expect(res.profiles).toBeGreaterThan(10);   // US Core has many profiles
    expect(res.valueSets).toBeGreaterThan(0);
  });

  it("installs US Core profiles into the conformance store", async () => {
    const profiles = await listInstalledProfiles(wh);
    expect(profiles.length).toBeGreaterThan(10);
    expect(profiles.some((p) => p.url === US_CORE_PATIENT)).toBe(true);
  });

  it("isProfileInstalled resolves a known US Core profile", async () => {
    expect(await isProfileInstalled(wh, US_CORE_PATIENT)).toBe(true);
    expect(await isProfileInstalled(wh, "http://example.com/not-installed")).toBe(false);
  });
});
