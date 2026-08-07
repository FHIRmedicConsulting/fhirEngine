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
    if (def.type === "composite") {
      if (def.components) compositeRows(code, def, resource, out);
      continue;
    }
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

/** Resolve a component expression under the restricted grammar (`prop`, `prop.as(Type)`, unions
 * with `|`) against one base element. `value.as(Quantity)` → element.valueQuantity, etc. */
function componentValues(el: Record<string, unknown>, expr: string): unknown[] {
  const out: unknown[] = [];
  for (const part of expr.split("|").map((s) => s.trim()).filter(Boolean)) {
    const path = part.replace(/(\w+)\.as\((\w+)\)/g, (_, p: string, t: string) => p + t[0]!.toUpperCase() + t.slice(1));
    let cur: unknown = el;
    for (const seg of path.split(".")) {
      if (cur == null || typeof cur !== "object") { cur = undefined; break; }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur !== undefined && cur !== null) out.push(...(Array.isArray(cur) ? cur : [cur]));
  }
  return out;
}

/** Materialize a composite param as same-element rows: system = component-1 token (canonical
 * `sys|code` AND bare `code` encodings), value = component-2 value. Same-element correctness
 * comes from pairing components within each base element, which flat per-param rows lose. */
function compositeRows(code: string, def: { expression: string; components?: Array<{ expression: string; type: string }> }, resource: Record<string, unknown>, out: SearchIndexEntry[]): void {
  const [c1, c2] = def.components!;
  if (!c1 || !c2) return;
  const rt = String(resource.resourceType);
  const bases: unknown[] = [];
  for (const part of def.expression.split("|").map((s) => s.trim()).filter(Boolean)) {
    if (part === rt) bases.push(resource);
    else if (part.startsWith(`${rt}.`)) bases.push(...componentValues(resource, part.slice(rt.length + 1)));
  }
  for (const el of bases) {
    if (!el || typeof el !== "object") continue;
    const tokens = codingsOf(componentValues(el as Record<string, unknown>, c1.expression));
    const values = compositeComp2(componentValues(el as Record<string, unknown>, c2.expression), c2.type);
    for (const t of tokens) {
      for (const v of values) {
        if (t.system) out.push({ code, system: `${t.system}|${t.code}`, value: v });
        out.push({ code, system: t.code, value: v });
      }
    }
  }
}

/** Flatten component-1 results (CodeableConcept / Coding / bare code) to {system?, code} pairs. */
function codingsOf(results: unknown[]): Array<{ system?: string; code: string }> {
  const out: Array<{ system?: string; code: string }> = [];
  for (const r of results) {
    if (typeof r === "string") { out.push({ code: r }); continue; }
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, any>;
    if (Array.isArray(o.coding)) {
      for (const c of o.coding) if (c?.code) out.push({ system: c.system, code: String(c.code) });
    } else if (o.code !== undefined) {
      out.push({ system: o.system, code: String(o.code) });
    }
  }
  return out;
}

/** Component-2 values by type: quantity → numeric string; token → codes (bare + `sys|code`);
 * string → lowercased; date → every instant (dateTime or Period bounds). */
function compositeComp2(results: unknown[], type: string): string[] {
  const out: string[] = [];
  for (const r of results) {
    switch (type) {
      case "quantity":
        if (typeof r === "number" || typeof r === "string") out.push(String(r));
        else if (r && typeof r === "object" && (r as any).value !== undefined) out.push(String((r as any).value));
        break;
      case "token":
        for (const t of codingsOf([r])) {
          out.push(t.code);
          if (t.system) out.push(`${t.system}|${t.code}`);
        }
        break;
      case "string":
        if (typeof r === "string") out.push(r.toLowerCase());
        break;
      case "date":
        out.push(...dateValues(r));
        break;
    }
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
      // A date param's FHIRPath often yields a Period ({start,end}) or Timing (event[]/repeat.bounds),
      // not a bare string — e.g. Encounter.date=period, Procedure.date=performed[x], Condition
      // onset/abatement. Index every instant found so range/prefix matches work; a bare string/number
      // (dateTime/instant) indexes directly. (Was: only bare strings → Period-typed date search
      // silently returned empty.)
      dateValues(r).forEach((v) => push(out, code, v));
      break;
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

/** Pull the date instants a `date`-param value can carry: a bare dateTime/instant string, a
 * Period ({start,end}), or a Timing ({event[], repeat.boundsPeriod}). Returns all found. */
function dateValues(r: unknown): string[] {
  if (typeof r === "string" || typeof r === "number") return [String(r)];
  if (!r || typeof r !== "object") return [];
  const o = r as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["start", "end", "valueDateTime", "valueDate", "valueInstant"]) {
    if (typeof o[k] === "string") out.push(o[k] as string);
  }
  if (Array.isArray(o.event)) for (const e of o.event) if (typeof e === "string") out.push(e);
  const bounds = (o.repeat as Record<string, unknown> | undefined)?.boundsPeriod as Record<string, unknown> | undefined;
  if (bounds) for (const k of ["start", "end"]) if (typeof bounds[k] === "string") out.push(bounds[k] as string);
  return out;
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
