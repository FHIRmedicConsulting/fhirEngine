/**
 * L4 — FHIRPath invariant validation (the resource/element `constraint` expressions,
 * error severity, from the R4 snapshot; generic ele-/ext-/dom- are excluded).
 * In-process via the `fhirpath` engine. First cut evaluates top-level + one-level-nested
 * constraints (e.g. pat-1 on Patient.contact); deeper-nested contexts are deferred.
 */
import fhirpath from "fhirpath";
import type { ValidationIssue } from "./structural-validator.js";

export interface Invariant {
  path: string;
  key: string;
  expression: string;
}

/** Nodes at a constraint's element path (root resource, or one level down). */
function nodesAtPath(resource: any, path: string, rt: string): any[] {
  if (path === rt) return [resource];
  const rest = path.slice(rt.length + 1);
  if (rest.includes(".")) return []; // deeper than one level — deferred (first cut)
  const v = resource[rest];
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function validateInvariants(resource: Record<string, unknown>, invariants: Invariant[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const rt = String(resource.resourceType);
  for (const inv of invariants) {
    const nodes = nodesAtPath(resource, inv.path, rt);
    for (const node of nodes) {
      let ok = true;
      try {
        const res = fhirpath.evaluate(node, inv.expression) as unknown[];
        ok = res.length === 0 ? true : res.every((x: unknown) => x !== false);
      } catch {
        ok = true; // expression needs a model / unevaluable → skip (don't false-fail)
      }
      if (!ok) {
        issues.push({ path: inv.path, message: `invariant ${inv.key} violated: ${inv.expression}` });
        break; // one failure per constraint is enough
      }
    }
  }
  return issues;
}
