/**
 * Generate the Patient compartment map ({ resourceType: [linking search-param codes] })
 * from the CC0 R4 Core CompartmentDefinition-patient. Used by Patient/$everything.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const R4 = "/Users/chad/.fhir/packages/hl7.fhir.r4.core#4.0.1/package";
const OUT = join(import.meta.dirname, "../src/fhir-schema/patient-compartment.json");

const cd = JSON.parse(readFileSync(join(R4, "CompartmentDefinition-patient.json"), "utf8"));
const map: Record<string, string[]> = {};
for (const r of cd.resource ?? []) {
  if (r.param && r.param.length) map[r.code] = r.param;
}
writeFileSync(OUT, JSON.stringify(map));
console.log(`patient-compartment: ${Object.keys(map).length} resource types. e.g. Observation -> ${map.Observation}`);
