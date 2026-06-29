/**
 * TS-native structural validator (L1/L2) — recursive over the vendored R4 columnar
 * schema (clean-room registry + `required` flag). Runs IN-PROCESS in the shared TS tier
 * (no Python, no IPC) — the runtime validation TS types can't do (they're erased).
 *
 * Checks: required elements present (base cardinality), list-vs-scalar shape, and basic
 * primitive types. Depth-capped JSON columns are not descended (matches the flattener).
 * Deeper format checks (date regex, etc.) + bindings (L3) + profiles (L2–L5) layer on top.
 */
import type { Column, ColType } from "../fhir-schema/clean-room-flattener.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

/** FHIR R4 primitive format regexes (anchored) for the format-bearing string types. */
const FORMAT: Record<string, RegExp> = {
  date: /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1]))?)?$/,
  dateTime: /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/,
  instant: /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/,
  time: /^([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?$/,
  code: /^[^\s]+(\s[^\s]+)*$/,
  id: /^[A-Za-z0-9\-.]{1,64}$/,
  oid: /^urn:oid:[0-2](\.(0|[1-9][0-9]*))+$/,
  uuid: /^urn:uuid:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
};

function checkValue(v: unknown, t: ColType, fhirType: string, path: string, issues: ValidationIssue[]): void {
  switch (t.kind) {
    case "scalar": {
      const ok =
        t.arrow === "bool" ? typeof v === "boolean"
        : t.arrow === "int32" || t.arrow === "float64" ? typeof v === "number"
        : typeof v === "string"; // utf8
      if (!ok) { issues.push({ path, message: `expected ${t.arrow}, got ${typeof v}` }); break; }
      const fmt = FORMAT[fhirType];
      if (fmt && typeof v === "string" && !fmt.test(v)) {
        issues.push({ path, message: `invalid ${fhirType} format: '${v}'` });
      }
      break;
    }
    case "struct": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        issues.push({ path, message: "expected an object" });
      } else {
        walk(v as Record<string, unknown>, t.fields, path, issues);
      }
      break;
    }
    case "json":
      break; // depth-capped / open type — not descended
  }
}

function walk(obj: Record<string, unknown>, cols: Column[], path: string, issues: ValidationIssue[]): void {
  for (const c of cols) {
    const v = obj[c.name];
    if (v === undefined || v === null) {
      if (c.required) issues.push({ path: `${path}.${c.name}`, message: "required element missing" });
      continue;
    }
    const p = `${path}.${c.name}`;
    if (c.list) {
      if (!Array.isArray(v)) { issues.push({ path: p, message: "expected an array" }); continue; }
      if (c.required && v.length === 0) issues.push({ path: p, message: "required element is empty" });
      v.forEach((item, i) => checkValue(item, c.type, c.fhirType, `${p}[${i}]`, issues));
    } else {
      if (Array.isArray(v)) issues.push({ path: p, message: "expected a single value, got an array" });
      else checkValue(v, c.type, c.fhirType, p, issues);
    }
  }
}

/** Validate a resource's structure against its R4 columnar schema. Empty = valid. */
export function validateStructural(resource: Record<string, unknown>, cols: Column[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walk(resource, cols, String(resource.resourceType ?? "Resource"), issues);
  return issues;
}
