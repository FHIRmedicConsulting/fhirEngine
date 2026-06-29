/**
 * Zod schemas for REST-boundary FHIR resource validation.
 *
 * Post-A3 (session 023): generated types from `@ronin/fhir-types` own the
 * type SHAPE. Zod's residual job is the load-bearing REST-boundary
 * **cardinality + enum + required-field** checks — what the FHIR spec
 * actually requires at the wire. Helper datatype schemas (Period, Identifier,
 * Reference, etc.) were decommissioned: `.passthrough()` carries the shape
 * through without re-typing it here, and `as Patient` / `as Coverage` /
 * `as ExplanationOfBenefit` casts at the route layer narrow to the generated
 * types.
 *
 * Per ADR-0015 §2: this is the shoulder gate, not the conformance gate.
 * Profile-level validation (must-support, value-set binding, slicing,
 * FHIRPath invariants) is downstream in the Silver-tier Spark transpiler;
 * full FHIR shape correctness is enforced by the generated types at the
 * TypeScript layer.
 *
 * What stays at the REST boundary:
 *   - `resourceType` literal (discriminator).
 *   - Required-field presence (status, beneficiary, payor, insurance, ...).
 *   - Required-array cardinality (`payor[]>=1`, `insurance[]>=1`).
 *   - Enum-bound fields (status, use, outcome, gender).
 *
 * Anything outside that list is preserved via `.passthrough()` and validated
 * downstream.
 */

import { z } from "zod";

/** Generic FHIR object placeholder. `.passthrough()` preserves the body. */
const FhirObject = z.object({}).passthrough();

// --- Coverage ---

export const CoverageSchema = z
  .object({
    resourceType: z.literal("Coverage"),
    status: z.enum(["active", "cancelled", "draft", "entered-in-error"]),
    beneficiary: FhirObject,
    payor: z.array(FhirObject).min(1),
  })
  .passthrough();

export type CoverageInput = z.infer<typeof CoverageSchema>;

// --- ExplanationOfBenefit ---

export const ExplanationOfBenefitSchema = z
  .object({
    resourceType: z.literal("ExplanationOfBenefit"),
    status: z.enum(["active", "cancelled", "draft", "entered-in-error"]),
    // `type` is required by the generated EOB shape AND drives C4BB profile
    // selection in `EobRepository.c4bbProfileForType()` — required at the
    // REST boundary too.
    type: FhirObject,
    use: z.enum(["claim", "preauthorization", "predetermination"]),
    outcome: z.enum(["queued", "complete", "error", "partial"]),
    patient: FhirObject,
    insurer: FhirObject,
    provider: FhirObject,
    created: z.string(),
    insurance: z.array(FhirObject).min(1),
  })
  .passthrough();

export type ExplanationOfBenefitInput = z.infer<typeof ExplanationOfBenefitSchema>;

// --- Patient ---

export const PatientSchema = z
  .object({
    resourceType: z.literal("Patient"),
    gender: z.enum(["male", "female", "other", "unknown"]).optional(),
  })
  .passthrough();

export type PatientInput = z.infer<typeof PatientSchema>;

// --- Generic resource (standalone Delta CRUD; ADR-0022) ---

/**
 * REST-boundary check for the generic `:resourceType` Delta path. Per the
 * shoulder-gate posture above: require a non-empty `resourceType` discriminator
 * and (if present) a string `id`; the route asserts `resourceType` matches the
 * URL. Everything else passes through to Bronze (raw landing, Layering B) and is
 * validated downstream at Bronze→Silver.
 */
export const GenericResourceSchema = z
  .object({
    resourceType: z.string().min(1),
    id: z.string().optional(),
  })
  .passthrough();

export type GenericResourceInput = z.infer<typeof GenericResourceSchema>;
