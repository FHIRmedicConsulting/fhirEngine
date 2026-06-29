/**
 * Build the per-resource search index materialized at write time. For each supported
 * search param of the resource's type, evaluate its FHIRPath expression and normalize the
 * results into `{ code, system, value }` rows that the search route matches against.
 *
 * Supported types: token (code/Coding/CodeableConcept/Identifier/ContactPoint/boolean),
 * string (HumanName/Address/string — flattened to leaf strings, lowercased for
 * case-insensitive prefix match), date, uri, reference (simple `.reference`).
 */
import fhirpath from "fhirpath";
import { searchParamsFor } from "../fhir-schema/r4-search-params.js";
import { fhirpathR4Model } from "../lib/fhirpath-model.js";

export interface SearchIndexEntry { code: string; system: string; value: string }

export function buildSearchIndex(resource: Record<string, unknown>): SearchIndexEntry[] {
  const params = searchParamsFor(String(resource.resourceType));
  const out: SearchIndexEntry[] = [];
  for (const [code, def] of Object.entries(params)) {
    let results: unknown[];
    try {
      results = fhirpath.evaluate(resource as any, def.expression, undefined, fhirpathR4Model) as unknown[];
    } catch {
      continue; // expression needs resolve()/model or is unevaluable → skip this param
    }
    for (const r of results) extract(code, def.type, r, out);
  }
  return out;
}

function push(out: SearchIndexEntry[], code: string, value: unknown, system = ""): void {
  if (value === undefined || value === null || value === "") return;
  out.push({ code, system, value: String(value) });
}

function extract(code: string, type: string, r: unknown, out: SearchIndexEntry[]): void {
  if (r === undefined || r === null) return;
  switch (type) {
    case "token":
      token(code, r, out);
      break;
    case "string":
      strings(code, r, out);
      break;
    case "date":
    case "uri":
    case "number":
      if (typeof r === "string" || typeof r === "number" || typeof r === "boolean") push(out, code, r);
      break;
    case "quantity":
      // Quantity → numeric value (+ system for unit-aware match). Bare number also supported.
      if (typeof r === "number" || typeof r === "string") push(out, code, r);
      else if (r && typeof r === "object" && (r as any).value !== undefined) {
        push(out, code, (r as any).value, (r as any).system ?? (r as any).unit ?? "");
      }
      break;
    case "reference":
      if (typeof r === "object" && (r as any).reference) push(out, code, (r as any).reference);
      break;
  }
}

function token(code: string, r: unknown, out: SearchIndexEntry[]): void {
  if (typeof r === "string" || typeof r === "boolean" || typeof r === "number") {
    push(out, code, r);
    return;
  }
  if (typeof r !== "object" || r === null) return;
  const o = r as Record<string, any>;
  if (Array.isArray(o.coding)) {
    for (const c of o.coding) if (c?.code) push(out, code, c.code, c.system ?? "");
    return;
  }
  if (o.code !== undefined && o.system !== undefined) { push(out, code, o.code, o.system); return; } // Coding
  if (o.value !== undefined) { push(out, code, o.value, o.system ?? ""); return; } // Identifier / ContactPoint
  if (o.code !== undefined) push(out, code, o.code);
}

function strings(code: string, r: unknown, out: SearchIndexEntry[]): void {
  if (typeof r === "string") { push(out, code, r.toLowerCase()); return; }
  if (typeof r !== "object" || r === null) return;
  // Flatten leaf strings (e.g. HumanName.family/given/text, Address.city/line/...).
  const seen: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") seen.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const k of Object.keys(v as object)) if (k !== "id") walk((v as any)[k]);
  };
  walk(r);
  for (const s of seen) push(out, code, s.toLowerCase());
}
