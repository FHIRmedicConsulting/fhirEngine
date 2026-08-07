/**
 * Repository-side data-path filter builder.
 *
 * Routes call `buildDataFilter(auth, resourceType, verb)` to get the filter
 * the repository must apply at the SQL layer. This is points 3 + 4 of the
 * five-point chain implemented at the data path, not the request gate.
 *
 *   - patient_compartment_id: when present, all reads MUST filter by this
 *     patient_id. The repository injects `WHERE patient_id = ?`.
 *   - query_restrictions: when present, each key/value pair adds a
 *     `WHERE <key> IN (<values>)` clause at the repository layer.
 */

import type { AuthContext } from "./auth-context.js";
import { enforce, type RequestVerb } from "./scope-enforcer.js";
import { forbidden } from "../lib/errors.js";
import { patientCompartment } from "../fhir-schema/patient-compartment.js";

export interface DataFilter {
  /** Patient compartment scope; null = no compartment filter. */
  patientCompartmentId: string | null;
  /** Granular query restrictions from scope `?` parameters. */
  queryRestrictions: Record<string, string[]>;
}

export function buildDataFilter(
  auth: AuthContext,
  resourceType: string,
  verb: RequestVerb,
): DataFilter {
  const result = enforce({ resourceType, verb, auth });
  if (!result.authorized) {
    // FAIL CLOSED. The prior "defensive empty filter" fell open: operation endpoints
    // that bypass the middleware's capitalized-path scope check (`$export`, `_history`)
    // called this and treated a null compartment as "no restriction" → an unauthorized
    // token could read across all patients. Deny explicitly instead.
    throw forbidden(result.denialReason ?? `Insufficient scope for ${verb} on ${resourceType}`);
  }
  const restrictions: Record<string, string[]> = {};
  for (const [k, values] of Object.entries(result.queryRestrictions)) {
    restrictions[k] = Array.from(values).sort();
  }
  // Compartment filtering only applies to types that ARE in the patient compartment
  // (CompartmentDefinition/patient). Supporting resources a patient app must still read —
  // Practitioner, Organization, Location, Medication — carry no patient reference, so a
  // patient_id filter can never match them: applying it turned every such read/search/_include
  // into a 404/empty for patient-context tokens ((g)(10) Single Patient API failures).
  // "Patient" itself is the compartment root and stays filtered to the launch patient.
  const compartmentApplies = resourceType === "Patient" || resourceType === "Resource"
    || resourceType in patientCompartment;
  return {
    patientCompartmentId: compartmentApplies ? result.patientCompartmentFilter : null,
    queryRestrictions: restrictions,
  };
}
