/**
 * Build-time generator: derive the clean-room columnar schema for EVERY concrete
 * FHIR R4 Core resource type and vendor them as one JSON registry
 * (`src/fhir-schema/r4-core-schemas.json`). The registry is the runtime artifact —
 * the server never parses StructureDefinitions at runtime (works in-container, no
 * FHIR cache needed). Re-run when bumping the R4 Core package.
 *
 * Source: HL7 FHIR R4 Core StructureDefinitions (CC0). Run:
 *   R4_CORE=<pkg> node scripts/generate-r4-schemas.ts
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { generateSchema } from "../src/fhir-schema/clean-room-flattener.ts";

const R4 =
  process.env.R4_CORE ??
  "/Users/chad/.fhir/packages/hl7.fhir.r4.core#4.0.1/package";
const OUT = "src/fhir-schema/r4-core-schemas.json";

function concreteResourceTypes(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(R4)) {
    if (!f.startsWith("StructureDefinition-") || !f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(`${R4}/${f}`, "utf8"));
      if (d.kind === "resource" && d.derivation === "specialization" && !d.abstract) out.push(d.type);
    } catch { /* skip */ }
  }
  return out.sort();
}

const types = concreteResourceTypes();
const schemas: Record<string, unknown> = {};
// L4 invariants: per resource type, the error-severity FHIRPath constraints from the
// snapshot (path + key + expression). Top-level + one-level-nested are evaluated at runtime.
const constraints: Record<string, Array<{ path: string; key: string; expression: string }>> = {};
function collectConstraints(rt: string) {
  const sd = JSON.parse(readFileSync(`${R4}/StructureDefinition-${rt}.json`, "utf8"));
  const out: Array<{ path: string; key: string; expression: string }> = [];
  // Skip the generic base constraints (ele-1/ext-1/dom-*) — they're on every element and
  // are redundant with structural validation; keep resource/element-specific invariants.
  const GENERIC = /^(ele-1|ext-1|dom-[0-9]+)$/;
  for (const e of sd.snapshot?.element ?? []) {
    for (const c of e.constraint ?? []) {
      if (c.severity === "error" && c.expression && !GENERIC.test(c.key)) {
        out.push({ path: e.path, key: c.key, expression: c.expression });
      }
    }
  }
  return out;
}

const fails: string[] = [];
for (const t of types) {
  try {
    schemas[t] = generateSchema(t);
    constraints[t] = collectConstraints(t);
  } catch (e: any) {
    fails.push(`${t}: ${e.message}`);
  }
}

const registry = { fhirVersion: "4.0.1", source: "hl7.fhir.r4.core#4.0.1 (CC0)", resourceTypes: types, schemas, constraints };
writeFileSync(OUT, JSON.stringify(registry));
const bytes = readFileSync(OUT).length;
console.log(`wrote ${OUT}: ${types.length} resource types, ${(bytes / 1024).toFixed(0)} KB`);
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
