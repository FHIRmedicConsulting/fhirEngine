/**
 * TerminologyCapabilities (`/metadata?mode=terminology`) — the statement a FHIR terminology
 * client (e.g. the HL7 Java validator when pointed at us as its `-tx` server) fetches to learn
 * which code systems this server can validate/expand locally. Generated from the loaded
 * `codesystem_concept` table so it reflects what the operator actually provisioned.
 *
 * The validator uses `codeSystem[].uri` to decide which systems to delegate to us; systems we
 * don't list, it resolves from its own bundled packages.
 */
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";

const SOFTWARE_VERSION = "0.1.0";

export async function buildTerminologyCapabilities(
  wh: DeltaWarehouse,
  baseUrl: string,
): Promise<Record<string, unknown>> {
  let systems: string[] = [];
  try {
    wh.registerTerminology("codesystem_concept");
    const rows = await wh.query<{ system: string }>(
      "SELECT DISTINCT system FROM codesystem_concept WHERE system IS NOT NULL AND system <> '' ORDER BY system",
    );
    systems = rows.map((r) => r.system);
  } catch {
    /* terminology store not provisioned → advertise no local code systems */
  }

  return {
    resourceType: "TerminologyCapabilities",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    software: { name: "fhirEngine", version: SOFTWARE_VERSION },
    implementation: { description: "fhirEngine local terminology server (delta-rs/DataFusion)", url: baseUrl },
    // codeSearch is omitted: its value set diverges between R4 (explicit|all)
    // and R5 (in-compose|…), and both R4 and R5 clients parse this statement.
    // Empty arrays are invalid FHIR JSON — only emit codeSystem when non-empty.
    ...(systems.length ? { codeSystem: systems.map((uri) => ({ uri })) } : {}),
    expansion: { hierarchical: true, paging: true },
    validateCode: { translations: false },
  };
}
