/**
 * IG-package install facility (provisioning) — the priority-#2 gate.
 *
 * Installs a FHIR IG npm package (e.g. hl7.fhir.us.core#6.1.0) in ONE pass: its
 * StructureDefinitions → the conformance store (installed profiles), and its
 * CodeSystems/ValueSets/ConceptMaps → the terminology store. (An IG package carries
 * both; see docs/standalone/terminology-and-provisioning.md.) Pure-local, no JVM.
 *
 * First cut installs/registers profiles (queryable + advertisable). Deriving the
 * profile *validators* (must-support/slicing/bindings) into the sidecar
 * PROFILE_VALIDATORS is the next layer.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { loadTerminologyResources } from "../terminology/terminology-loader.js";

export interface InstallResult {
  package: string;
  profiles: number;
  extensions: number;
  codeSystems: number;
  valueSets: number;
  concepts: number;
  expansions: number;
}

/** Read the conformance/terminology resources from an unpacked FHIR npm package dir. */
function readPackageResources(packageDir: string): any[] {
  const out: any[] = [];
  for (const f of readdirSync(packageDir)) {
    if (!f.endsWith(".json") || f === "package.json" || f.startsWith(".")) continue;
    try {
      const r = JSON.parse(readFileSync(`${packageDir}/${f}`, "utf8"));
      if (r && typeof r.resourceType === "string") out.push(r);
    } catch { /* skip non-resource / malformed */ }
  }
  return out;
}

const CONFORMANCE = new Set(["StructureDefinition", "CodeSystem", "ValueSet", "ConceptMap"]);

export async function installIgPackage(
  wh: DeltaWarehouse,
  packageDir: string,
  packageId = packageDir,
): Promise<InstallResult> {
  const resources = readPackageResources(packageDir).filter((r) => CONFORMANCE.has(r.resourceType));

  // Profiles + extensions (StructureDefinitions) → conformance store.
  const sds = resources.filter((r) => r.resourceType === "StructureDefinition");
  const sdRows = sds.map((sd) => ({
    url: sd.url,
    name: sd.name ?? null,
    type: sd.type ?? null,
    kind: sd.kind ?? null,
    derivation: sd.derivation ?? null,
    baseDefinition: sd.baseDefinition ?? null,
    version: sd.version ?? null,
    package: packageId,
    json: JSON.stringify(sd),
  }));
  if (sdRows.length) await wh.writeConformance("structuredefinition", sdRows);

  // Terminology (CS/VS/CM) → terminology store.
  const term = await loadTerminologyResources(wh, resources);

  return {
    package: packageId,
    profiles: sds.filter((s) => s.derivation === "constraint" && s.type !== "Extension").length,
    extensions: sds.filter((s) => s.type === "Extension").length,
    codeSystems: term.codeSystems,
    valueSets: term.valueSets,
    concepts: term.concepts,
    expansions: term.expansions,
  };
}

export interface InstalledProfile { [k: string]: unknown; url: string; type: string; name: string | null }

/** List installed profiles (derivation=constraint StructureDefinitions). */
export async function listInstalledProfiles(wh: DeltaWarehouse): Promise<InstalledProfile[]> {
  wh.registerConformance("structuredefinition");
  return wh.query<InstalledProfile>(
    "SELECT url, type, name FROM structuredefinition WHERE derivation = 'constraint'",
  );
}

/** Is a profile (by canonical URL) installed? */
export async function isProfileInstalled(wh: DeltaWarehouse, url: string): Promise<boolean> {
  wh.registerConformance("structuredefinition");
  const rows = await wh.query("SELECT url FROM structuredefinition WHERE url = ? LIMIT 1", [url]);
  return rows.length > 0;
}
