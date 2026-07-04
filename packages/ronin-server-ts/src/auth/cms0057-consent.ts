/**
 * CMS-0057 exchange-consent gates. Two of the CMS-0057 APIs are patient-consent scoped:
 *
 *   • Payer-to-Payer  — **OPT-IN**  (default DENY; permitted only with an active permit Consent)
 *   • Provider Access — **OPT-OUT** (default ALLOW; blocked only by an active deny Consent)
 *
 * Both are OFF by default (env-gated) so dev/synthetic + existing behavior are unchanged; production
 * enablement is a deploy gate. A Consent is "for" a given exchange when it is `status=active` and
 * carries a category coding whose `code` matches the exchange's category. Those category codes are
 * **operator-configurable** (payers bind their own policy codes) — the defaults are the plain
 * descriptive codes documented below. This is deliberately a thin, well-scoped gate: rich policy
 * evaluation (DS4P, provisions, purpose-of-use) is the heritage consent engine (ADR-0030/0018).
 */
import { DeltaResourceRepository } from "../repository/delta-resource-repository.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";

export const p2pConsentRequired = (): boolean => process.env.RONIN_P2P_CONSENT_REQUIRED === "true";
export const providerAccessOptOutEnabled = (): boolean => process.env.RONIN_PROVIDER_ACCESS_OPTOUT === "true";

const P2P_CATEGORY = (): string => process.env.RONIN_P2P_CONSENT_CATEGORY ?? "payer-to-payer";
const PROVIDER_CATEGORY = (): string => process.env.RONIN_PROVIDER_ACCESS_CATEGORY ?? "provider-access";

interface Consent { status?: string; category?: Array<{ coding?: Array<{ code?: string }> }>; provision?: { type?: string } }

const hasCategory = (con: Consent, code: string): boolean =>
  (con.category ?? []).some((cc) => (cc.coding ?? []).some((c) => c.code === code));

/** Active Consents for a patient scoped to a CMS-0057 exchange category. */
async function exchangeConsents(wh: DeltaWarehouse, patientRef: string, category: string): Promise<Consent[]> {
  const ref = patientRef.startsWith("Patient/") ? patientRef : `Patient/${patientRef}`;
  const repo = new DeltaResourceRepository(wh, "Consent");
  const r = await repo.searchByParams({ conds: [{ code: "patient", type: "reference", value: ref }], count: 100, offset: 0 });
  return (r.resources as unknown as Consent[]).filter((con) => con.status === "active" && hasCategory(con, category));
}

/** Payer-to-Payer is OPT-IN: an active deny blocks; otherwise an explicit permit is required. */
export async function payerToPayerPermitted(wh: DeltaWarehouse, patientRef: string): Promise<boolean> {
  const cons = await exchangeConsents(wh, patientRef, P2P_CATEGORY());
  if (cons.some((c) => c.provision?.type === "deny")) return false;
  return cons.some((c) => c.provision?.type === "permit");
}

/** Provider Access is OPT-OUT: allowed unless an active deny Consent exists. */
export async function providerAccessPermitted(wh: DeltaWarehouse, patientRef: string): Promise<boolean> {
  const cons = await exchangeConsents(wh, patientRef, PROVIDER_CATEGORY());
  return !cons.some((c) => c.provision?.type === "deny");
}

/** Drop patient ids that have opted out of Provider Access (used to scope Group/$export attribution). */
export async function filterProviderOptOut(wh: DeltaWarehouse, patientIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const pid of patientIds) if (await providerAccessPermitted(wh, pid)) out.push(pid);
  return out;
}
