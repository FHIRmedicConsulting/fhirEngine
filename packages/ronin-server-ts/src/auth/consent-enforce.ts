/**
 * Read-time consent + DS4P label enforcement (ADR-0030 controls #3/#4) for the delta routes.
 *
 * Two layers:
 *   - DEFAULT POLICY (heritage `consent-gate`): HCS confidentiality/sensitivity + scope-context
 *     (system→allow, patient→own-compartment, user→deny R/V + any sensitivity).
 *   - COMPUTABLE-CONSENT OVERRIDE: when the default would deny a sensitive/restricted resource,
 *     load the patient's active `Consent` resources and GRANT if a `permit` provision covers
 *     the blocking label for this requester/purpose. (FHIR Consent.provision.)
 *
 * Opt-in via `RONIN_CONSENT_ENFORCEMENT`; a no-op without an auth context.
 */
import { evaluateConsent, type GatedResource, type ConsentDecision } from "./consent-gate.js";
import { forbidden } from "../lib/errors.js";
import type { AuthContext } from "./auth-context.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { DeltaResourceRepository } from "../repository/delta-resource-repository.js";
import type { Resource as FhirResource } from "@ronin/fhir-types";

export const consentEnabled = (): boolean => process.env.RONIN_CONSENT_ENFORCEMENT === "true";

/** Resolve a resource's patient-compartment id (Patient.id, or a subject/patient/beneficiary ref). */
export function resolveCompartmentPatient(resource: GatedResource): string | null {
  const r = resource as any;
  if (r.resourceType === "Patient") return r.id ?? null;
  const ref: unknown = r.subject?.reference ?? r.patient?.reference ?? r.beneficiary?.reference;
  if (typeof ref === "string" && ref.startsWith("Patient/")) return ref.slice("Patient/".length);
  return null;
}

// --- Computable-consent override (FHIR Consent.provision) ---

function periodActive(period: { start?: string; end?: string } | undefined, now: string): boolean {
  if (!period) return true;
  if (period.start && now < period.start) return false;
  if (period.end && now > period.end) return false;
  return true;
}

/** Does an actor/purpose-matched `permit` provision cover any blocking label? (empty list = wildcard) */
function provisionPermits(prov: any, blocking: string[], auth: AuthContext, now: string): boolean {
  if (!prov || !periodActive(prov.period, now)) return false;
  const labels = (prov.securityLabel ?? []).map((l: any) => l.code).filter(Boolean);
  const coversLabel = labels.length === 0 || blocking.some((b) => labels.includes(b));
  const actors = prov.actor ?? [];
  const actorOk = actors.length === 0 || actors.some((a: any) => {
    const ref = a?.reference?.reference;
    return typeof ref === "string" && (ref === auth.fhirUser || ref.endsWith(`/${auth.clientId}`) || ref.endsWith(`/${auth.subject}`));
  });
  const purposes = (prov.purpose ?? []).map((p: any) => p.code).filter(Boolean);
  const purposeOk = purposes.length === 0 || (auth.purposeOfUse != null && purposes.includes(auth.purposeOfUse));
  if (prov.type === "permit" && coversLabel && actorOk && purposeOk) return true;
  return (prov.provision ?? []).some((sub: any) => provisionPermits(sub, blocking, auth, now)); // nested
}

function consentGrants(consents: any[], blocking: string[], auth: AuthContext): boolean {
  const now = new Date().toISOString();
  return consents.some((c) => c.status === "active" && provisionPermits(c.provision, blocking, auth, now));
}

async function activeConsentsFor(wh: DeltaWarehouse, patientId: string, cache: Map<string, any[]>): Promise<any[]> {
  if (cache.has(patientId)) return cache.get(patientId)!;
  let consents: any[] = [];
  try {
    consents = await new DeltaResourceRepository(wh, "Consent").findReferencing(["patient", "subject"], `Patient/${patientId}`);
  } catch { /* no Consent table → no overrides */ }
  cache.set(patientId, consents);
  return consents;
}

/** Single-read/vread gate: 403 unless the default policy allows OR a Consent provision grants. */
export async function enforceReadConsent(wh: DeltaWarehouse, resource: FhirResource, auth: AuthContext | undefined): Promise<void> {
  if (!consentEnabled() || !auth) return;
  const patientId = resolveCompartmentPatient(resource as unknown as GatedResource);
  const decision = evaluateConsent({ resource: resource as unknown as GatedResource, resourceCompartmentPatientId: patientId, auth });
  if (decision.allowed) return;
  if (decision.blockingLabels?.length && patientId) {
    const consents = await activeConsentsFor(wh, patientId, new Map());
    if (consentGrants(consents, decision.blockingLabels, auth)) return; // granted by Consent
  }
  throw forbidden(decision.reason);
}

/** Search/$everything filter: keep entries the caller may receive (default policy + Consent override). */
export async function filterReadConsent<R extends FhirResource>(
  wh: DeltaWarehouse,
  resources: R[],
  auth: AuthContext | undefined,
): Promise<{ allowed: R[]; filtered: Array<{ resource: R; decision: ConsentDecision }> }> {
  if (!consentEnabled() || !auth) return { allowed: [...resources], filtered: [] };
  const cache = new Map<string, any[]>();
  const allowed: R[] = [];
  const filtered: Array<{ resource: R; decision: ConsentDecision }> = [];
  for (const r of resources) {
    const patientId = resolveCompartmentPatient(r as unknown as GatedResource);
    const decision = evaluateConsent({ resource: r as unknown as GatedResource, resourceCompartmentPatientId: patientId, auth });
    if (decision.allowed) { allowed.push(r); continue; }
    if (decision.blockingLabels?.length && patientId && consentGrants(await activeConsentsFor(wh, patientId, cache), decision.blockingLabels, auth)) {
      allowed.push(r);
      continue;
    }
    filtered.push({ resource: r, decision });
  }
  return { allowed, filtered };
}
