/**
 * Generate the R4 search-parameter registry from the vendored hl7.fhir.r4.core package
 * (CC0). One entry per (resourceType, param code) → { type, expression } where the
 * expression is the FHIRPath clause specific to that resource type.
 *
 * First cut keeps the runtime-supported types (token | string | date | reference | uri);
 * number/quantity/composite/special are dropped (noted; not yet searchable).
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const R4 = "/Users/chad/.fhir/packages/hl7.fhir.r4.core#4.0.1/package";
const OUT = join(import.meta.dirname, "../src/fhir-schema/r4-search-params.json");
const KEEP = new Set(["token", "string", "date", "reference", "uri", "number", "quantity"]);

type Entry = { type: string; expression: string; target?: string[] };
const registry: Record<string, Record<string, Entry>> = {};

let files = 0, kept = 0, dropped = 0;
for (const f of readdirSync(R4)) {
  if (!f.startsWith("SearchParameter-") || !f.endsWith(".json")) continue;
  files++;
  const sp = JSON.parse(readFileSync(join(R4, f), "utf8"));
  const code: string = sp.code;
  const type: string = sp.type;
  const bases: string[] = sp.base ?? [];
  const expr: string = sp.expression ?? "";
  if (!code || !type || !expr || !bases.length) continue;
  if (!KEEP.has(type)) { dropped++; continue; }

  // A multi-base expression is "Type1.a | Type2.b | ...". Pick the clause(s) for each base.
  // Strip `.where(resolve() is X)` type-filters — fhirpath can't resolve() at index time,
  // and we match references by exact value anyway (the type filter is redundant for that).
  const stripResolve = (s: string) => s.replace(/\.where\(\s*resolve\(\)\s+is\s+[^)]+\)/g, "").trim();
  const clauses = expr.split("|").map((s) => s.trim()).filter(Boolean);
  for (const base of bases) {
    // A clause belongs to this base if it references `<Base>.` anywhere (handles
    // paren-wrapped / `as` forms like "(Observation.value as Quantity)").
    const forBase = clauses.filter((c) => c === base || c.includes(`${base}.`)).map(stripResolve);
    if (!forBase.length) continue;
    const entry: Entry = { type, expression: forBase.join(" | ") };
    if (type === "reference" && Array.isArray(sp.target) && sp.target.length) entry.target = sp.target;
    (registry[base] ??= {})[code] = entry;
    kept++;
  }
}

writeFileSync(OUT, JSON.stringify(registry));
const bytes = readFileSync(OUT).length;
console.log(`search-params: scanned ${files} files, kept ${kept} (resourceType,code) entries across ${Object.keys(registry).length} types, dropped ${dropped} unsupported-type. ${(bytes / 1024).toFixed(0)} KB`);
console.log(`Patient params: ${Object.keys(registry.Patient ?? {}).sort().join(", ")}`);
