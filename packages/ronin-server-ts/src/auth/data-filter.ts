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
    // Middleware should have already rejected; defensive empty filter
    return { patientCompartmentId: null, queryRestrictions: {} };
  }
  const restrictions: Record<string, string[]> = {};
  for (const [k, values] of Object.entries(result.queryRestrictions)) {
    restrictions[k] = Array.from(values).sort();
  }
  return {
    patientCompartmentId: result.patientCompartmentFilter,
    queryRestrictions: restrictions,
  };
}
