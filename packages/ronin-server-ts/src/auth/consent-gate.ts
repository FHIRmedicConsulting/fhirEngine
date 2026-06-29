/**
 * Consent gate — point 5 of the five-point scope+consent enforcement chain
 * per ADR-0006 §5 + ADR-0018 §5.
 *
 * Read-time filter that consumes SLS-populated `meta.security` labels per
 * ADR-0015 Amendment 2 + the auth context's scope context + purpose-of-use
 * to decide whether a given resource may be disclosed to the caller.
 *
 * The gate is **pure** — no I/O, no Consent-record lookups. It evaluates:
 *   - The resource's HCS confidentiality coding (N | R | V | M | L | U).
 *   - The resource's HCS sensitivity codings (ETH, PSY, HIV, SUD, GDIS, ...).
 *   - The caller's scope context (system | user | patient | other).
 *   - The launch patient (when patient-context).
 *   - The Purpose-of-Use claim from the X-Purpose-Of-Use header.
 *
 * Per ADR-0018 §5.2 the v1 default policy is:
 *
 *   - System-context (`system/*`) — always allow (administrative access).
 *   - Patient-context where the resource belongs to the launched patient
 *     compartment — always allow (patient owns own data, including sensitive).
 *   - User-context (Practitioner) — allow `Normal` (N) confidentiality;
 *     `Restricted` (R) requires explicit policy-level Consent (v1: deny;
 *     v1.x: check stored Consent records).
 *   - Anything else (anonymous, unauthenticated) — deny.
 *
 * For sensitivity tags (ETH/PSY/HIV/SUD/GDIS) the default is:
 *   - System-context — allow.
 *   - Patient-context (own data) — allow.
 *   - User-context — deny unless `purposeOfUse = TREATMENT` AND deployment
 *     opts in (v1: deny; v1.x: deployment-config opt-in).
 *
 * v1 ships defaults; v1.x adds:
 *   - Stored `Consent` resource lookup (per-patient policy granularity).
 *   - Deployment-configurable rule overrides.
 *   - Per-purpose-of-use rule matrices.
 *
 * The gate works correctly when `meta.security` is empty (SLS rule engine
 * not yet running) — empty labels = `Normal` confidentiality = allowed.
 * That posture is what session 024's SLS-column-NULL state already produces.
 */

import type { Coverage, ExplanationOfBenefit, Patient } from "@ronin/fhir-types";
import { patientIdFromReference } from "../lib/ronin-fhir-utils.js";
import { forbidden } from "../lib/errors.js";
import type { AuthContext } from "./auth-context.js";

/** HCS confidentiality codes per `http://terminology.hl7.org/CodeSystem/v3-Confidentiality`. */
export type Confidentiality =
  | "U" // Unrestricted
  | "L" // Low
  | "M" // Moderate
  | "N" // Normal (default)
  | "R" // Restricted
  | "V"; // Very Restricted

/** HCS sensitivity codes (most-common subset; not exhaustive). */
export const SENSITIVITY_CODES = new Set([
  "ETH", // Substance abuse
  "PSY", // Psychiatry
  "HIV",
  "SUD", // Substance use disorder (newer code)
  "GDIS", // Genetic disease
  "SEX", // Sexual & reproductive
  "STD", // Sexually transmitted
  "TBOO", // Taboo
  "B",   // Behavioral
]);

const HCS_CONFIDENTIALITY_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-Confidentiality";

const HCS_SENSITIVITY_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-ActCode";

export interface ConsentDecision {
  allowed: boolean;
  /** Recorded in AuditEvent.outcomeDesc + the filter-out warning. */
  reason: string;
  /**
   * The filtered confidentiality / sensitivity codes that triggered the
   * decision. Populated when the gate denies; empty otherwise.
   */
  blockingLabels?: string[];
}

/**
 * The minimum resource shape the gate inspects: `resourceType` discriminator
 * + optional `meta.security` labels. Structural typing means concrete
 * generated types (Patient, Coverage, ExplanationOfBenefit) satisfy it
 * implicitly — no index signature needed.
 */
export interface GatedResource {
  resourceType: string;
  id?: string;
  meta?: {
    security?: Array<{ system?: string; code?: string }>;
  };
}

export interface ConsentGateInput {
  /** The resource being considered for disclosure. Read-only. */
  resource: GatedResource;
  /**
   * The compartment patient id this resource belongs to. Provided by the
   * caller (route layer) because each resource type extracts its own
   * compartment anchor (Patient.id, Coverage.beneficiary, EOB.patient).
   * `null` when not patient-compartment-bound (e.g., AuditEvent for a
   * cross-system event).
   */
  resourceCompartmentPatientId: string | null;
  /** Auth context from the introspection middleware. */
  auth: AuthContext;
}

const ALLOW = (reason: string): ConsentDecision => ({ allowed: true, reason });
const DENY = (reason: string, blockingLabels: string[] = []): ConsentDecision => ({
  allowed: false,
  reason,
  blockingLabels,
});

/**
 * Decide whether the caller may receive the resource.
 *
 * Default policy per ADR-0018 §5.2; deployment override is v1.x.
 */
export function evaluateConsent(input: ConsentGateInput): ConsentDecision {
  const { resource, resourceCompartmentPatientId, auth } = input;
  const labels = resource.meta?.security ?? [];

  const confidentiality = readConfidentiality(labels);
  const sensitivityTags = readSensitivityTags(labels);
  const scopeContext = primaryScopeContext(auth);

  // 1. Unauthenticated — never allowed (defensive; auth middleware would have
  //    rejected first).
  if (auth.subject === "anonymous" || auth.subject === "unauthenticated") {
    return DENY("unauthenticated request blocked by consent gate");
  }

  // 2. System-context — administrative; always allow.
  if (scopeContext === "system") {
    return ALLOW("system-context: administrative access");
  }

  // 3. Patient-context: own data → allow regardless of sensitivity.
  //    Different patient → deny (defense-in-depth; compartment filter at
  //    point 4 should have already rejected this).
  if (scopeContext === "patient") {
    if (auth.launchPatientId === null) {
      return DENY(
        "patient-context scope without launch/patient claim cannot resolve compartment",
      );
    }
    if (resourceCompartmentPatientId === auth.launchPatientId) {
      return ALLOW("patient-context: own compartment data");
    }
    return DENY(
      `patient-context scope launched as ${auth.launchPatientId} cannot read compartment of ${resourceCompartmentPatientId ?? "<unbound>"}`,
    );
  }

  // 4. User-context (Practitioner) — confidentiality + sensitivity gating.
  if (scopeContext === "user") {
    // Restricted or Very-Restricted confidentiality blocked by default.
    if (confidentiality === "R" || confidentiality === "V") {
      return DENY(
        `user-context scope cannot read ${confidentiality}-confidentiality resource without explicit Consent`,
        [confidentiality],
      );
    }
    // Sensitivity tag blocked by default unless treatment PPOU + deployment
    // opt-in (v1: always deny when sensitivity tag present).
    if (sensitivityTags.length > 0) {
      return DENY(
        `user-context scope cannot read sensitive resource (tags: ${sensitivityTags.join(", ")}) without explicit Consent`,
        sensitivityTags,
      );
    }
    return ALLOW("user-context: normal confidentiality, no sensitivity tags");
  }

  // 5. Anything else (e.g., a future scope context) — default deny.
  return DENY(`unrecognized scope context: ${scopeContext}`);
}

/**
 * Route helper: evaluate consent and throw a 403 FhirError when denied.
 *
 * Single-resource read paths (`GET /Patient/{id}`, `GET /Coverage/{id}`,
 * `GET /ExplanationOfBenefit/{id}`) call this immediately after the
 * repository returns. The auth-context-undefined case is a defensive
 * bypass for tests; in production the auth middleware always runs first.
 */
export function enforceConsentOrThrow(
  resource: GatedResource,
  auth: AuthContext | undefined,
): void {
  if (!auth) return;
  const decision = evaluateConsent({
    resource,
    resourceCompartmentPatientId: compartmentPatientIdFor(resource),
    auth,
  });
  if (!decision.allowed) {
    throw forbidden(decision.reason);
  }
}

/**
 * Resolve the patient-compartment id for a v1 resource. Mirrors each
 * repository's `CompartmentAnchor.extract` but lives next to the gate so
 * route layers don't have to reach into repository internals.
 *
 * Returns `null` when the resource isn't in any single-patient compartment
 * (e.g., a Practitioner or Organization).
 */
export function compartmentPatientIdFor(
  resource: GatedResource,
): string | null {
  switch (resource.resourceType) {
    case "Patient":
      return (resource as Patient).id ?? null;
    case "Coverage":
      return patientIdFromReference((resource as Coverage).beneficiary);
    case "ExplanationOfBenefit":
      return patientIdFromReference((resource as ExplanationOfBenefit).patient);
    default:
      return null;
  }
}

/**
 * Apply the gate to an array of resources. Returns the survivors + the
 * filtered-out items (with their decisions, for OperationOutcome warning
 * emission in Bundle responses).
 *
 * Used by search routes and `$everything` to filter Bundle entries.
 */
export function filterByConsent<R extends GatedResource>(
  resources: R[],
  resourceCompartmentResolver: (resource: GatedResource) => string | null,
  auth: AuthContext | undefined,
): {
  allowed: R[];
  filtered: Array<{ resource: R; decision: ConsentDecision }>;
} {
  // No auth context = test bypass; production always has one.
  if (!auth) return { allowed: [...resources], filtered: [] };
  const allowed: R[] = [];
  const filtered: Array<{ resource: R; decision: ConsentDecision }> = [];
  for (const resource of resources) {
    const decision = evaluateConsent({
      resource,
      resourceCompartmentPatientId: resourceCompartmentResolver(resource),
      auth,
    });
    if (decision.allowed) {
      allowed.push(resource);
    } else {
      filtered.push({ resource, decision });
    }
  }
  return { allowed, filtered };
}

// --- internal ---

function readConfidentiality(
  labels: Array<{ system?: string; code?: string }>,
): Confidentiality {
  for (const c of labels) {
    if (c.system === HCS_CONFIDENTIALITY_SYSTEM && c.code) {
      if (isConfidentiality(c.code)) return c.code;
    }
  }
  // Default to Normal when not labeled (matches FHIR + HCS posture).
  return "N";
}

function readSensitivityTags(
  labels: Array<{ system?: string; code?: string }>,
): string[] {
  const tags: string[] = [];
  for (const c of labels) {
    if (
      c.system === HCS_SENSITIVITY_SYSTEM &&
      c.code &&
      SENSITIVITY_CODES.has(c.code)
    ) {
      tags.push(c.code);
    }
  }
  return tags;
}

function isConfidentiality(code: string): code is Confidentiality {
  return ["U", "L", "M", "N", "R", "V"].includes(code);
}

type ScopeContext = "system" | "user" | "patient" | "other";

function primaryScopeContext(auth: AuthContext): ScopeContext {
  // Find the first non-`other` context across the parsed scopes.
  // (Most tokens carry one context kind; mixed-context tokens are rare.)
  let hasPatient = false;
  let hasUser = false;
  let hasSystem = false;
  for (const s of auth.scopes) {
    if (s.context === "system") hasSystem = true;
    else if (s.context === "user") hasUser = true;
    else if (s.context === "patient") hasPatient = true;
  }
  // Most-restrictive-wins per ADR-0006 §5 §point 4 ordering: patient > user > system
  if (hasPatient) return "patient";
  if (hasUser) return "user";
  if (hasSystem) return "system";
  return "other";
}
