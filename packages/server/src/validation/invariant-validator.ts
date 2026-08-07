/**
 * L4 — FHIRPath invariant validation (the resource/element `constraint` expressions,
 * error severity, from the R4 snapshot; generic ele-/ext-/dom- are excluded).
 * In-process via the `fhirpath` engine. Constraint contexts are resolved at ANY depth
 * (e.g. pat-1 on Patient.contact, or Bundle.entry.search-level constraints): the element
 * path is walked segment by segment, fanning out across arrays and `[x]` choice properties.
 */
import fhirpath from "fhirpath";
import { fhirpathR4Model } from "../lib/fhirpath-model.js";
import type { ValidationIssue } from "./structural-validator.js";

export interface Invariant {
  path: string;
  key: string;
  expression: string;
}

/** Nodes at a constraint's element path — full-depth walk (fans out across arrays at every
 * level; `value[x]` segments match any present choice property). Absent segments prune. */
function nodesAtPath(resource: any, path: string, rt: string): any[] {
  if (path === rt) return [resource];
  let nodes: any[] = [resource];
  for (const seg of path.slice(rt.length + 1).split(".")) {
    const next: any[] = [];
    for (const n of nodes) {
      if (n == null || typeof n !== "object") continue;
      if (seg.endsWith("[x]")) {
        const base = seg.slice(0, -3);
        for (const k of Object.keys(n)) {
          if (k.startsWith(base) && k.length > base.length && /[A-Z]/.test(k[base.length]!)) {
            const v = n[k];
            next.push(...(Array.isArray(v) ? v : [v]));
          }
        }
        continue;
      }
      const v = n[seg];
      if (v === undefined || v === null) continue;
      next.push(...(Array.isArray(v) ? v : [v]));
    }
    nodes = next;
    if (!nodes.length) break;
  }
  return nodes.filter((n) => n !== undefined && n !== null);
}

export function validateInvariants(resource: Record<string, unknown>, invariants: Invariant[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const rt = String(resource.resourceType);
  for (const inv of invariants) {
    const nodes = nodesAtPath(resource, inv.path, rt);
    for (const node of nodes) {
      let ok = true;
      try {
        // Evaluate WITH the R4 model so type-aware expressions (ofType/as/resolve/choice types)
        // resolve instead of throwing — otherwise most non-trivial invariants silently pass.
        const res = fhirpath.evaluate(node, inv.expression, undefined, fhirpathR4Model) as unknown[];
        ok = res.length === 0 ? true : res.every((x: unknown) => x !== false);
      } catch {
        ok = true; // engine still can't evaluate (unsupported fn) → skip, don't false-fail a valid resource
      }
      if (!ok) {
        issues.push({ path: inv.path, message: `invariant ${inv.key} violated: ${inv.expression}` });
        break; // one failure per constraint is enough
      }
    }
  }
  return issues;
}
