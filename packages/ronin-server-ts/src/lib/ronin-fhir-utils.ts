/**
 * Ronin-specific utilities that aren't part of `@ronin/fhir-types`.
 *
 * Most FHIR types come from the generated `@ronin/fhir-types` package (R4
 * core today; per-IG profile narrowings will land incrementally). The
 * generated types are stricter than what Ronin hand-rolled — typed
 * `Reference<T>` targets, value-set enum unions, closed `resourceType`
 * unions on `Resource`. This module adds the small set of Ronin-side
 * helpers that don't have a generated equivalent:
 *
 *   - `SearchsetBundle<T>` — generated `Bundle` is non-generic; we wrap it
 *     so route code can keep typing search responses by entry resource type.
 *   - `patientIdFromReference()` — extracts the `<id>` portion of a
 *     `Patient/<id>` Reference. The reverse of `Reference<"Patient">`'s
 *     template-literal type.
 *
 * Per session-022 migration plan §4.1.
 */

import type { Bundle, BundleEntry, Reference, Resource } from "@ronin/fhir-types";

/**
 * Search-result Bundle parameterized by entry resource type. Replacement
 * for the hand-rolled `Bundle<T>` shape: generated `Bundle.entry?` is
 * `BundleEntry[]` (any resource); we narrow `entry[i].resource` to a
 * specific `T extends Resource`.
 *
 * Used by `/Patient`, `/Coverage`, `/ExplanationOfBenefit` searchset routes.
 */
export type SearchsetBundle<T extends Resource> = Omit<Bundle, "entry"> & {
  entry?: Array<Omit<BundleEntry<T>, "resource"> & { resource: T }>;
};

/**
 * Extract the bare `<id>` portion of a `Patient/<id>` Reference, if present.
 *
 * Returns `null` when the reference is missing or doesn't match the
 * `Patient/<id>` shape. The Patient compartment anchor and the Coverage
 * beneficiary anchor both run through this.
 */
export function patientIdFromReference(ref: Reference | undefined): string | null {
  if (!ref?.reference) return null;
  const m = ref.reference.match(/^Patient\/([^/]+)$/);
  return m ? m[1]! : null;
}
