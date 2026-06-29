/**
 * Operator-supplied terminology file loaders (LOINC/SNOMED/RxNorm) → codesystem_concept,
 * verified via $validate-code. Loads a small `limit` slice of the REAL release files.
 * Gated on the sidecar AND on the licensed folders being present (RONIN_TERMINOLOGY_DIR).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { loadLoinc, loadSnomed, loadRxNorm, LOINC_SYS, SNOMED_SYS, RXNORM_SYS } from "../../src/terminology/file-loaders.js";
import { validateCode } from "../../src/terminology/validate-code.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";
const TERM = process.env.RONIN_TERMINOLOGY_DIR ?? "../../terminologies";
const has = (p: string) => existsSync(join(TERM, p));

const loincDir = join(TERM, "Loinc_2.82");
const snomedDir = join(TERM, "SnomedCT_ManagedServiceUS_PRODUCTION_US1000124_20260301T120000Z");
const rxnormDir = join(TERM, "RxNorm_full_06012026");
const ready = !!SIDECAR && has("Loinc_2.82");

describe.skipIf(!ready)("terminology file loaders", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  beforeAll(async () => { if (SIDECAR && !(await wh.health())) throw new Error("sidecar down"); });

  it("loads LOINC and validates a loaded code", async () => {
    const r = await loadLoinc(wh, loincDir, { limit: 200 });
    expect(r.system).toBe(LOINC_SYS);
    expect(r.concepts).toBe(200);
    // read back a real loaded code and validate it
    const [row] = await wh.query<{ code: string }>("SELECT code FROM codesystem_concept WHERE system = ? LIMIT 1", [LOINC_SYS]);
    const v = await validateCode(wh, { system: LOINC_SYS, code: row.code });
    expect(v.status).toBe("valid");
    const bad = await validateCode(wh, { system: LOINC_SYS, code: "not-a-loinc-zzz" });
    expect(bad.status).toBe("invalid"); // system loaded, code absent
  });

  it.skipIf(!has("SnomedCT_ManagedServiceUS_PRODUCTION_US1000124_20260301T120000Z"))(
    "loads SNOMED (code-only, fast) and validates", async () => {
      const r = await loadSnomed(wh, snomedDir, { limit: 200, descriptions: false });
      expect(r.system).toBe(SNOMED_SYS);
      expect(r.concepts).toBe(200);
      const [row] = await wh.query<{ code: string }>("SELECT code FROM codesystem_concept WHERE system = ? LIMIT 1", [SNOMED_SYS]);
      expect((await validateCode(wh, { system: SNOMED_SYS, code: row.code })).status).toBe("valid");
    });

  it.skipIf(!has("RxNorm_full_06012026"))("loads RxNorm and validates", async () => {
    const r = await loadRxNorm(wh, rxnormDir, { limit: 200 });
    expect(r.system).toBe(RXNORM_SYS);
    expect(r.concepts).toBe(200);
    const [row] = await wh.query<{ code: string }>("SELECT code FROM codesystem_concept WHERE system = ? LIMIT 1", [RXNORM_SYS]);
    expect((await validateCode(wh, { system: RXNORM_SYS, code: row.code })).status).toBe("valid");
  });
});
