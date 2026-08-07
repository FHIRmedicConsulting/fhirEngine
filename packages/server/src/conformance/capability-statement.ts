/**
 * Accurate CapabilityStatement (`/metadata`) generated from the live server surface:
 * the R4 Core resource registry + the interactions the delta app actually implements +
 * installed profiles (supportedProfile) from the conformance store.
 *
 * Kept honest — declares what's actually wired: CRUD + vread, instance/type/system history,
 * batch + transaction, rich search, $validate/$everything/$export, and the terminology +
 * CMS-0057 operations that have live handlers. (NOTE: transaction is NOT fully atomic — an
 * append-only store has no cross-resource rollback; see routes/transaction.ts.)
 */
import { r4CoreResourceTypes } from "../fhir-schema/r4-registry.js";
import { searchParamsFor } from "../fhir-schema/r4-search-params.js";
import { listInstalledProfiles } from "./ig-loader.js";
import { smartSecurityBlock } from "./smart-configuration.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";

const SOFTWARE_VERSION = "0.1.0-alpha.6";

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

  // If any installed profile is US Core, advertise instantiation of the US Core server
  // CapabilityStatement (Inferno (g)(10) us_core_instantiate check).
  const instantiatesUsCore = [...profilesByType.values()].flat().some((u) => u.includes("/us/core/"));

  // Terminology operations exposed per resource (fhirEngine is a local tx server).
  const TERMINOLOGY_OPS: Record<string, Array<{ name: string; definition: string }>> = {
    ValueSet: [
      { name: "expand", definition: "http://hl7.org/fhir/OperationDefinition/ValueSet-expand" },
      { name: "validate-code", definition: "http://hl7.org/fhir/OperationDefinition/ValueSet-validate-code" },
    ],
    CodeSystem: [
      { name: "validate-code", definition: "http://hl7.org/fhir/OperationDefinition/CodeSystem-validate-code" },
      { name: "lookup", definition: "http://hl7.org/fhir/OperationDefinition/CodeSystem-lookup" },
    ],
  };

  // Per-resource operations: every type supports $validate; Patient adds $everything; the
  // terminology resources add their tx ops. $export IS advertised — it's async + disk-backed
  // (routes/export.ts), not the old in-memory stub.
  const operationsFor = (rt: string) => {
    const ops = [{ name: "validate", definition: "http://hl7.org/fhir/OperationDefinition/Resource-validate" }];
    if (rt === "Patient") ops.push(
      { name: "everything", definition: "http://hl7.org/fhir/OperationDefinition/Patient-everything" },
      { name: "export", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/patient-export" },
      { name: "member-match", definition: "http://hl7.org/fhir/us/davinci-hrex/OperationDefinition/member-match" },
    );
    if (rt === "Group") ops.push({ name: "export", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/group-export" });
    if (rt === "Claim") ops.push(
      { name: "submit", definition: "http://hl7.org/fhir/us/davinci-pas/OperationDefinition/Claim-submit" },
      { name: "inquire", definition: "http://hl7.org/fhir/us/davinci-pas/OperationDefinition/Claim-inquire" },
    );
    if (rt === "Questionnaire") ops.push(
      { name: "questionnaire-package", definition: "http://hl7.org/fhir/us/davinci-dtr/OperationDefinition/questionnaire-package" },
    );
    if (TERMINOLOGY_OPS[rt]) ops.push(...TERMINOLOGY_OPS[rt]);
    return ops;
  };

  // Real search params for the type (the generic engine indexes every registry param) + the
  // common base params we support. Deduped by name.
  // Only advertise params the engine actually applies (token/string/date/number/quantity/uri/
  // reference). Composite/special params are rejected at search time (not silently ignored), so
  // advertising them would be dishonest.
  const HANDLEABLE = new Set(["token", "string", "date", "number", "quantity", "uri", "reference"]);
  const searchParamsAdvertised = (rt: string) => {
    const out = new Map<string, { name: string; type: string }>();
    out.set("_id", { name: "_id", type: "token" });
    out.set("_lastUpdated", { name: "_lastUpdated", type: "date" });
    for (const [name, def] of Object.entries(searchParamsFor(rt))) {
      if (HANDLEABLE.has(def.type)) out.set(name, { name, type: def.type });
    }
    return [...out.values()];
  };

  const resources = r4CoreResourceTypes.map((rt) => ({
    type: rt,
    interaction: [
      { code: "read" }, { code: "vread" }, { code: "update" }, { code: "delete" }, { code: "create" },
      { code: "search-type" }, { code: "history-instance" }, { code: "history-type" },
    ],
    versioning: "versioned",
    readHistory: true,
    updateCreate: false,          // PUT [type]/[id] does not create a client-id'd resource (404)
    conditionalCreate: true,      // POST + If-None-Exist
    conditionalUpdate: true,      // PUT [type]?<search>
    conditionalDelete: "single",  // DELETE [type]?<search> (single match)
    ...(profilesByType.has(rt) ? { supportedProfile: profilesByType.get(rt) } : {}),
    searchRevInclude: ["Provenance:target"], // US Core provenance revinclude (generic _revinclude)
    searchParam: searchParamsAdvertised(rt),
    operation: operationsFor(rt),
  }));

  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    software: { name: "fhirEngine", version: SOFTWARE_VERSION },
    implementation: { description: "fhirEngine OSS-Delta FHIR R4 server (delta-rs/DataFusion)", url: baseUrl },
    fhirVersion: "4.0.1",
    // tx-ecosystem feature declarations the HL7 validator's tx client reads
    // (TerminologyClientContext.checkFeature). CodeSystemAsParameter is TRUE —
    // $validate-code/$expand/$lookup honor client-supplied CodeSystems/ValueSets
    // via the tx-resource parameter (tx-resource-overlay). The tx-tests
    // `test-version` feature is DELIBERATELY absent: it claims the HL7
    // terminology test battery passes, and it doesn't yet — declare it only
    // once `validator_cli txTests` is green (until then validator users need
    // -authorise-non-conformant-tx-servers).
    extension: [
      {
        url: "http://hl7.org/fhir/uv/application-feature/StructureDefinition/feature",
        extension: [
          { url: "definition", valueCanonical: "http://hl7.org/fhir/uv/tx-ecosystem/FeatureDefinition/CodeSystemAsParameter" },
          { url: "value", valueCode: "true" },
        ],
      },
    ],
    ...(instantiatesUsCore ? { instantiates: ["http://hl7.org/fhir/us/core/CapabilityStatement/us-core-server"] } : {}),
    format: ["application/fhir+json"], // JSON only — honest (no XML/ttl); drop the bare "json" shorthand
    rest: [
      {
        mode: "server",
        documentation: "R4 Core CRUD + vread + instance/type/system history + rich search (token/string/date/number/quantity/uri/reference, modifiers, chaining, _has, _include/_revinclude, _sort/_summary/_elements, paging) + POST _search + conditional create/update/delete + transaction/batch + $everything + $validate + terminology ops, on a single/medallion Delta store.",
        security: smartSecurityBlock(baseUrl),
        interaction: [
          { code: "transaction" }, { code: "batch" }, { code: "history-system" },
        ],
        resource: resources,
        operation: [
          { name: "validate", definition: "http://hl7.org/fhir/OperationDefinition/Resource-validate" },
          { name: "export", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export" }, // system-level Bulk Data
        ],
      },
    ],
  };
}
