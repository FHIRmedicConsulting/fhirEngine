/**
 * Per-handler scope enforcement.
 *
 * Implements points 2 + 3 + 4 of the five-point chain (point 1 = introspection
 * happens upstream; point 5 = Consent gate is in ADR-0018 §5 and deferred).
 *
 * Point 2 (ops check):
 *   For request to `<METHOD> /Resource[/id]`, find scopes whose:
 *     - resourceType matches (or "*")
 *     - context permits the request (patient/* in launch/patient context, etc.)
 *     - operations include the verb derived from METHOD
 *   At least one matching scope must exist.
 *
 * Point 3 (granular query restriction):
 *   Each matching scope may carry queryRestrictions ({ category: "lab" }).
 *   The union of restrictions across matching scopes is the effective filter
 *   applied at the repository layer.
 *
 * Point 4 (Patient compartment):
 *   When all matching scopes are `patient/*` AND a `launch/patient` context
 *   is present (auth.patient_id populated), every read filters by patient_id.
 */

import type { AuthContext } from "./auth-context.js";
import type { CanonicalScope, ScopeOperation } from "./smart-versions/types.js";

/**
 * The verb a request requires. Maps HTTP method → CRUDS letter using FHIR
 * REST conventions.
 */
export type RequestVerb = ScopeOperation;

export function verbForRequest(method: string, hasResourceId: boolean): RequestVerb {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return hasResourceId ? "r" : "s";
  if (m === "POST") return "c";
  if (m === "PUT" || m === "PATCH") return "u";
  if (m === "DELETE") return "d";
  throw new Error(`No scope verb mapping for HTTP method: ${method}`);
}

export interface EnforcementResult {
  /** True if at least one scope authorizes the request. */
  authorized: boolean;
  /** The union of query restrictions from matching scopes (point 3). */
  queryRestrictions: Record<string, Set<string>>;
  /**
   * Patient compartment filter to apply (point 4). Null = no compartment
   * filter; string = required patient_id filter.
   */
  patientCompartmentFilter: string | null;
  /** Scopes that matched the request, for AuditEvent capture. */
  matchedScopes: CanonicalScope[];
  /** Reason for denial when authorized=false. */
  denialReason?: string;
}

export interface EnforcementInput {
  /** FHIR resource type from the route, e.g., "Patient". */
  resourceType: string;
  /** Required verb derived from the HTTP method + presence of {id} segment. */
  verb: RequestVerb;
  /** The auth context (scopes + launch claims). */
  auth: AuthContext;
}

export function enforce(input: EnforcementInput): EnforcementResult {
  const { resourceType, verb, auth } = input;

  // Find scopes that match (resourceType + verb permitted)
  const matching = auth.scopes.filter((s) => scopeMatches(s, resourceType, verb));

  if (matching.length === 0) {
    return {
      authorized: false,
      queryRestrictions: {},
      patientCompartmentFilter: null,
      matchedScopes: [],
      denialReason: `No scope grants ${verb} on ${resourceType}`,
    };
  }

  // Point 4: if every matching scope is patient-context AND we have a launch
  // patient context, require the compartment filter.
  const allPatientContext = matching.every((s) => s.context === "patient");
  const launchPatient = auth.launchPatientId ?? null;
  const patientCompartmentFilter = allPatientContext && launchPatient ? launchPatient : null;

  if (allPatientContext && !launchPatient) {
    return {
      authorized: false,
      queryRestrictions: {},
      patientCompartmentFilter: null,
      matchedScopes: [],
      denialReason: `patient/${resourceType} scope requires launch/patient context`,
    };
  }

  // Point 3: union query restrictions across matching scopes.
  // Multiple scopes restricting the same key form a "OR" set; the data layer
  // applies WHERE key IN (val1, val2).
  const queryRestrictions: Record<string, Set<string>> = {};
  for (const scope of matching) {
    for (const [k, v] of Object.entries(scope.queryRestrictions)) {
      if (!queryRestrictions[k]) queryRestrictions[k] = new Set();
      queryRestrictions[k]!.add(v);
    }
  }

  return {
    authorized: true,
    queryRestrictions,
    patientCompartmentFilter,
    matchedScopes: matching,
  };
}

function scopeMatches(
  scope: CanonicalScope,
  resourceType: string,
  verb: RequestVerb,
): boolean {
  // Non-resource scopes (openid, launch, etc.) never authorize FHIR ops
  if (scope.resourceType === null) return false;
  // Only patient/user/system contexts can authorize FHIR ops
  if (scope.context !== "patient" && scope.context !== "user" && scope.context !== "system") {
    return false;
  }
  // Resource type must match (or wildcard)
  if (scope.resourceType !== "*" && scope.resourceType !== resourceType) return false;
  // Verb must be in the granted operations set
  if (!scope.operations.includes(verb)) return false;
  return true;
}
