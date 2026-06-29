/**
 * Generic repository abstractions.
 *
 * Each FHIR resource type ships:
 *   - A `ResourceMeta` declaring the storage shape (table names, profiles).
 *   - A `CompartmentAnchor` extracting the Patient compartment ID per ADR-0006
 *     §5 point 4. Patient: `id`. Coverage: `beneficiary.reference`. Future
 *     Observation: `subject.reference` (when typed Patient).
 *   - A `DenormalizedExtractor` projecting body fields into the search-index
 *     columns per ADR-0005 §1.1 Layer 4c.
 *   - A `IdentifierExtractor` for the `(system, value, type_code)` index used
 *     by `searchByIdentifier`.
 *
 * The generic `ResourceRepository<T>` consumes these and provides CRUD +
 * conditional create + search by identifier without per-resource boilerplate.
 * Resource-specific repositories extend it for resource-specific operations
 * (temporal queries on Coverage, etc.).
 */

import type { Resource as FhirResource } from "@ronin/fhir-types";

export interface IdentifierIndexEntry {
  system: string;
  value: string;
  /** Type code, e.g., "MB" for CARIN BB member identifier. */
  typeCode: string | null;
}

export interface ResourceMeta<T extends FhirResource> {
  /** FHIR `resourceType` discriminator, e.g. "Patient" / "Coverage". */
  resourceType: T["resourceType"];
  /** Table name in the Bronze tier (without catalog prefix). */
  bronzeTable: string;
  /** Table name in the Gold current-version projection. */
  goldCurrentTable: string;
  /** Active profile URLs validated against (US Core + CARIN BB + ...). */
  activeProfiles: string[];
}

export interface CompartmentAnchor<T extends FhirResource> {
  /**
   * Return the patient_id the resource belongs to (compartment anchor) or
   * null if the resource is outside any single-patient compartment.
   */
  extract: (resource: T) => string | null;
}

export interface DenormalizedRow {
  fhir_id: string;
  version_id: number;
  last_updated: string;
  body_json: string;
  identifier_index: IdentifierIndexEntry[];
  /** Per-resource-type extension columns; serialized as a plain object. */
  ext: Record<string, unknown>;
}

export interface DenormalizedExtractor<T extends FhirResource> {
  /** Extract identifier index entries from the resource body. */
  extractIdentifiers: (resource: T) => IdentifierIndexEntry[];
  /** Extract resource-specific denormalized columns. */
  extractExt: (resource: T) => Record<string, unknown>;
}

/** Generic search-by-identifier hit. */
export interface SearchByIdentifierParams {
  system: string;
  value: string;
  /** Optional type filter, e.g., "MB" for member identifier. */
  typeCode?: string | null;
}
