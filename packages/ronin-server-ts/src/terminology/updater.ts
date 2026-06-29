/**
 * Configurable terminology updater (operator-picks). The operator enables which sources +
 * modes run; nothing auto-updates silently (operator-pulled, per the design's §7). Drives:
 *  - VSAC `$expand` for configured value sets (UMLS key via op run),
 *  - RxNav RxNorm version check,
 *  - "what's loaded" version report (vs. checks).
 */
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { loadVsacExpansion } from "./sources/vsac.js";
import { rxnormVersion } from "./sources/rxnav.js";

export interface TerminologyUpdateConfig {
  /** VSAC value sets to (re)expand by OID/canonical. */
  vsac?: { enabled: boolean; valueSets: string[] };
  /** Check the current RxNorm release version via RxNav. */
  rxnav?: { enabled: boolean };
  /** Report loaded CodeSystem versions (no fetch). */
  checkUpdates?: boolean;
}

export interface TerminologyUpdateReport {
  loaded: Array<{ system: string; version: string | null; count: number }>;
  vsac: Array<{ valueset: string; expansions: number }>;
  rxnorm?: { latest: string | null; loaded: string | null; current: boolean };
}

/** Loaded CodeSystem versions from `codesystem_header`. */
export async function loadedTerminologyVersions(wh: DeltaWarehouse): Promise<TerminologyUpdateReport["loaded"]> {
  wh.registerTerminology("codesystem_header");
  try {
    return await wh.query("SELECT url AS system, version, count FROM codesystem_header");
  } catch {
    return []; // header table not provisioned yet
  }
}

export async function runTerminologyUpdate(
  wh: DeltaWarehouse,
  config: TerminologyUpdateConfig,
  opts?: { fetchImpl?: typeof fetch },
): Promise<TerminologyUpdateReport> {
  const report: TerminologyUpdateReport = { loaded: [], vsac: [] };

  if (config.checkUpdates) report.loaded = await loadedTerminologyVersions(wh);

  if (config.vsac?.enabled) {
    for (const oid of config.vsac.valueSets ?? []) {
      report.vsac.push(await loadVsacExpansion(wh, oid, { fetchImpl: opts?.fetchImpl }));
    }
  }

  if (config.rxnav?.enabled) {
    const latest = await rxnormVersion({ fetchImpl: opts?.fetchImpl });
    const loaded = report.loaded.find((l) => l.system.includes("rxnorm"))?.version
      ?? (await loadedTerminologyVersions(wh)).find((l) => l.system.includes("rxnorm"))?.version
      ?? null;
    report.rxnorm = { latest, loaded, current: !!latest && latest === loaded };
  }

  return report;
}
