/**
 * `us-core-patient` profile per US Core 6.1.0:
 *   http://hl7.org/fhir/us/core/6.1.0/StructureDefinition-us-core-patient.html
 *
 * NARROWING THIS IS HAND-WRITTEN, NOT GENERATED. The codegen pipeline at
 * `packages/ronin-fhir-types/generate.ts` is configured for US Core 6.1.0,
 * but the in-sandbox run hits EMFILE on the large IG package and never
 * produces output. v1 ships a hand-written narrowing for the one profile
 * the v1 surface actually advertises (us-core-patient) so the API can:
 *   - enforce US-Core-level minimums at the REST boundary, and
 *   - stamp `meta.profile = [us-core-patient]` on responses that satisfy
 *     the profile.
 *
 * Codegen re-enablement (running locally without EMFILE) lands the
 * full profile catalog in v1.x.
 *
 * Constraints this type encodes (MUST per the IG):
 *   - `identifier` cardinality 1..* (each with `system` + `value`)
 *   - `name` cardinality 1..* (each with `family` OR `given`)
 *   - `gender` cardinality 1..1 (`male` | `female` | `other` | `unknown`)
 *
 * SHOULD constraints surfaced as runtime warnings rather than type
 * constraints (the type still accepts resources that lack them):
 *   - `birthDate` present (rendered as warning when absent)
 *   - `communication.language` from us-core-language-CV
 *   - `extension[us-core-race]`, `extension[us-core-ethnicity]`,
 *     `extension[us-core-birthsex]` present for the demographic data
 */

import type { Patient as BasePatient } from "../hl7-fhir-r4-core/Patient.js";
import type { HumanName } from "../hl7-fhir-r4-core/HumanName.js";
import type { Identifier } from "../hl7-fhir-r4-core/Identifier.js";

/**
 * Narrowed identifier shape: both `system` and `value` are required per
 * us-core-patient's slicing on `Identifier.system` + cardinality 1..1 on
 * `Identifier.value`.
 */
export interface USCorePatientIdentifier extends Identifier {
  system: string;
  value: string;
}

/**
 * Narrowed name shape: at least one of `family` or `given` is required per
 * us-core-patient's `name.given or name.family` invariant (`us-core-6`).
 *
 * TypeScript can't enforce "at least one of these two optional fields" with
 * a single shape — we use a union of two narrowed shapes (family-required
 * OR given-required).
 */
export type USCorePatientName =
  | (HumanName & { family: string })
  | (HumanName & { given: string[] });

/** US Core 6.1.0 `us-core-patient` profile. */
export interface USCorePatient extends BasePatient {
  resourceType: "Patient";
  identifier: USCorePatientIdentifier[];
  name: USCorePatientName[];
  gender: "male" | "female" | "other" | "unknown";
}

/** Profile URL the IG publishes; stamped into `meta.profile` on responses. */
export const US_CORE_PATIENT_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient";

/** US Core 6.1.0 extension URLs (subset relevant to us-core-patient). */
export const US_CORE_RACE_EXTENSION =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race";
export const US_CORE_ETHNICITY_EXTENSION =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity";
export const US_CORE_BIRTHSEX_EXTENSION =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex";
