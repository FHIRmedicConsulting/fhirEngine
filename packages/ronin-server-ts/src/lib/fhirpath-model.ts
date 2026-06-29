/**
 * The fhirpath R4 model context — required for FHIRPath to resolve choice types
 * (`value[x]` → `valueQuantity`), `ofType()`, and `as` casts against R4 resources.
 * Without it, search-param expressions like `(Observation.value as Quantity)` return empty.
 */
import r4Model from "fhirpath/fhir-context/r4";

export const fhirpathR4Model = r4Model;
