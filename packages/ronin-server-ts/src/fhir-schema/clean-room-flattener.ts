/**
 * Clean-room columnar flattener (ADR-0024) — derives a columnar schema from the
 * HL7 FHIR R4 StructureDefinitions (CC0) and flattens a resource into a typed row.
 * Ported from poc/delta-flatten-poc (proven across all 146 R4 types). No dbignite.
 *
 * Used Bronze→Silver: the flattened row is written to the Silver tier. Reads the R4
 * StructureDefinition package from `R4_CORE` (defaults to the local FHIR cache; must
 * be vendored into the image for containerized Silver promotion — follow-up).
 */
import { readFileSync } from "node:fs";

const R4_PKG =
  process.env.R4_CORE ??
  "/Users/chad/.fhir/packages/hl7.fhir.r4.core#4.0.1/package";

const MAX_DEPTH = 3;
const ALWAYS_STRINGIFY = new Set(["Resource", "Extension", "Narrative"]);

export type ColType =
  | { kind: "scalar"; arrow: string }
  | { kind: "struct"; fields: Column[] }
  | { kind: "json" };

export interface Column {
  name: string;
  list: boolean;
  fhirType: string;
  type: ColType;
  /** Base cardinality min>=1 — drives structural required-element validation. */
  required?: boolean;
  /** Required-binding ValueSet canonical (code-typed elements) — drives L3 validation. */
  binding?: string;
}

const PRIMITIVE_ARROW: Record<string, string> = {
  boolean: "bool", integer: "int32", positiveInt: "int32", unsignedInt: "int32",
  decimal: "float64",
  string: "utf8", code: "utf8", uri: "utf8", url: "utf8", canonical: "utf8",
  oid: "utf8", uuid: "utf8", id: "utf8", markdown: "utf8", base64Binary: "utf8",
  date: "utf8", dateTime: "utf8", instant: "utf8", time: "utf8", xhtml: "utf8",
  "http://hl7.org/fhirpath/System.String": "utf8",
};
const isPrimitive = (code: string) => code in PRIMITIVE_ARROW;

const sdCache = new Map<string, any>();
function loadSD(typeOrResource: string): any {
  if (sdCache.has(typeOrResource)) return sdCache.get(typeOrResource);
  const sd = JSON.parse(readFileSync(`${R4_PKG}/StructureDefinition-${typeOrResource}.json`, "utf8"));
  sdCache.set(typeOrResource, sd);
  return sd;
}

function childrenOf(elements: any[], parentPath: string): any[] {
  const depth = parentPath.split(".").length;
  return elements.filter((e) => {
    const segs = e.path.split(".");
    return segs.length === depth + 1 && e.path.startsWith(parentPath + ".");
  });
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const SKIP_ROOT = new Set([
  "id", "meta", "implicitRules", "language", "text", "contained", "extension", "modifierExtension",
]);

function buildStruct(elements: any[], parentPath: string, depth: number): Column[] {
  const cols: Column[] = [];
  for (const el of childrenOf(elements, parentPath)) {
    const localName = el.path.slice(parentPath.length + 1);
    const list = el.max === "*" || Number(el.max) > 1;
    const types: any[] = el.type ?? [];
    if (types.length === 0) continue;
    const isChoice = localName.endsWith("[x]");
    const base = isChoice ? localName.slice(0, -3) : localName;
    const reqd = (Number(el.min) || 0) >= 1;

    if (el.contentReference) {
      const ref = el.contentReference.replace(/^#/, "");
      const ct: ColType =
        depth + 1 >= MAX_DEPTH ? { kind: "json" } : { kind: "struct", fields: buildStruct(elements, ref, depth + 1) };
      cols.push({ name: base, list, fhirType: "BackboneElement", type: ct, required: reqd });
      continue;
    }
    const inline = childrenOf(elements, el.path);
    if (inline.length > 0) {
      const ct: ColType =
        depth + 1 >= MAX_DEPTH ? { kind: "json" } : { kind: "struct", fields: buildStruct(elements, el.path, depth + 1) };
      cols.push({ name: base, list, fhirType: types[0]?.code ?? "BackboneElement", type: ct, required: reqd });
      continue;
    }
    // Required binding on a code-typed element (L3). value[x] choices excluded.
    const binding =
      el.binding?.strength === "required" && el.binding?.valueSet
        ? String(el.binding.valueSet).split("|")[0]
        : undefined;
    for (const t of types) {
      const code: string = t.code;
      const colName = isChoice ? base + cap(code) : base;
      // choice elements: a required choice means "one of" present — don't mark each
      // variant required individually (checked at the choice level, future).
      cols.push({
        name: colName, list, fhirType: code, type: resolveType(code, depth),
        required: reqd && !isChoice,
        ...(["code", "Coding", "CodeableConcept"].includes(code) && !isChoice && binding ? { binding } : {}),
      });
      if (isPrimitive(code) && !isChoice) {
        cols.push({ name: "_" + colName, list, fhirType: "Element", type: { kind: "json" } });
      }
    }
  }
  return cols;
}

function resolveType(code: string, depth: number): ColType {
  if (isPrimitive(code)) return { kind: "scalar", arrow: PRIMITIVE_ARROW[code] };
  if (ALWAYS_STRINGIFY.has(code)) return { kind: "json" };
  if (depth + 1 >= MAX_DEPTH) return { kind: "json" };
  try {
    const fields = buildStruct(loadSD(code).snapshot.element, code, depth + 1);
    return fields.length ? { kind: "struct", fields } : { kind: "json" };
  } catch {
    return { kind: "json" };
  }
}

const schemaCache = new Map<string, Column[]>();
export function generateSchema(resourceType: string): Column[] {
  if (schemaCache.has(resourceType)) return schemaCache.get(resourceType)!;
  const all = buildStruct(loadSD(resourceType).snapshot.element, resourceType, 0);
  const cols = all.filter((c) => !SKIP_ROOT.has(c.name) && !SKIP_ROOT.has(c.name.replace(/^_/, "")));
  schemaCache.set(resourceType, cols);
  return cols;
}

function flattenScalar(v: any, t: ColType): any {
  switch (t.kind) {
    case "scalar": return v;
    case "json": return JSON.stringify(v);
    case "struct": {
      const out: Record<string, any> = {};
      for (const f of t.fields) out[f.name] = flattenValue(v[f.name], f);
      return out;
    }
  }
}
function flattenValue(val: any, col: Column): any {
  if (val === undefined || val === null) return null;
  if (col.list) return (val as any[]).map((v) => flattenScalar(v, col.type));
  return flattenScalar(val, col.type);
}

/** Flatten a resource into a row keyed by column name (id + body_json added by caller). */
export function flattenResource(resource: any, cols: Column[]): Record<string, any> {
  const row: Record<string, any> = {};
  for (const c of cols) row[c.name] = flattenValue(resource[c.name], c);
  return row;
}
