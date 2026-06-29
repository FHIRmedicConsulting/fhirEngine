/**
 * Accurate CapabilityStatement (`/metadata`) generated from the live server surface:
 * the R4 Core resource registry + the interactions the delta app actually implements +
 * installed profiles (supportedProfile) from the conformance store.
 *
 * Kept honest — only declares what's wired (CRUD, vread, instance history, identifier
 * search). System-level transaction/batch and richer search are NOT advertised until built.
 */
import { r4CoreResourceTypes } from "../fhir-schema/r4-registry.js";
import { listInstalledProfiles } from "./ig-loader.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";

const SOFTWARE_VERSION = "0.1.0";

export async function buildCapabilityStatement(wh: DeltaWarehouse, baseUrl: string): Promise<Record<string, unknown>> {
  const profilesByType = new Map<string, string[]>();
  try {
    for (const p of await listInstalledProfiles(wh)) {
      if (!p.type) continue;
      const list = profilesByType.get(p.type) ?? [];
      list.push(p.url);
      profilesByType.set(p.type, list);
    }
  } catch {
    /* conformance store not provisioned → no supportedProfile */
  }

  const resources = r4CoreResourceTypes.map((rt) => ({
    type: rt,
    interaction: [
      { code: "read" },
      { code: "vread" },
      { code: "update" },
      { code: "delete" },
      { code: "create" },
      { code: "search-type" },
      { code: "history-instance" },
    ],
    versioning: "versioned",
    readHistory: true,
    updateCreate: false,
    conditionalCreate: false,
    conditionalUpdate: false,
    conditionalDelete: "not-supported",
    ...(profilesByType.has(rt) ? { supportedProfile: profilesByType.get(rt) } : {}),
    searchParam: [{ name: "identifier", type: "token", documentation: "token search: system|value" }],
  }));

  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    software: { name: "RoninStandAlone", version: SOFTWARE_VERSION },
    implementation: { description: "RoninStandAlone OSS-Delta FHIR R4 server (delta-rs/DataFusion)", url: baseUrl },
    fhirVersion: "4.0.1",
    format: ["application/fhir+json", "json"],
    rest: [
      {
        mode: "server",
        documentation: "Generic R4 Core CRUD + vread/history + identifier search + $validate on a single/medallion Delta store.",
        resource: resources,
        operation: [{ name: "validate", definition: "http://hl7.org/fhir/OperationDefinition/Resource-validate" }],
      },
    ],
  };
}
