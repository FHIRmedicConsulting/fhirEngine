/**
 * Slicing validation (the hard FHIR layer). Conservative, correct first cut:
 *
 *  - Handles **value / pattern** discriminators (the dominant case: category/code/system
 *    slices). `exists`, `type`, `profile` discriminators → the slicing is skipped (not
 *    faked) so we never false-reject.
 *  - Enforces **required slices** (min ≥ 1), **max cardinality** per slice, and **closed
 *    slicing rules** (every element must match a defined slice — enforced only when every
 *    declared slice's discriminators were extractable, so unsupported discriminators can
 *    never cause a false rejection).
 *  - Discriminator fixed values are read from the slice's sub-elements by `id`
 *    (`<path>:<sliceName>.<discriminatorPath>` → fixed[x]/pattern[x]), or the slice
 *    element's own fixed/pattern navigated by the discriminator path.
 *  - Matching uses FHIRPath per discriminator path (per FHIR's discriminator model).
 *
 * Min-only + per-path matching is deliberately conservative: a conformant resource always
 * matches its required slice (no false-fail); only a genuinely-missing required slice fails.
 */
import fhirpath from "fhirpath";
import type { ValidationIssue } from "./structural-validator.js";

interface SliceDef { sliceName: string; min: number; max: number; discriminators: Array<{ path: string; value: unknown }> }
export interface Slicing {
  path: string;
  slices: SliceDef[];
  /** `closed` slicing rules are enforced (every element must match a defined slice) ONLY when
   * every declared slice's discriminators were extractable — otherwise conservatively open. */
  closed: boolean;
}

function fixedOrPatternValue(el: any): unknown {
  for (const k of Object.keys(el)) {
    if (k.startsWith("fixed") || k.startsWith("pattern")) return el[k];
  }
  return undefined;
}

/** Navigate a dot path into a pattern object (arrays → first element). */
function navigate(obj: any, path: string): unknown {
  let cur: any = obj;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[0];
    cur = cur?.[seg];
  }
  return Array.isArray(cur) ? cur[0] : cur;
}

/** Extract required, value/pattern-discriminated slicings from a profile snapshot. */
export function extractSlicings(snapshot: { element?: any[] }): Slicing[] {
  const els = snapshot.element ?? [];
  const byId = new Map<string, any>(els.map((e) => [e.id, e]));
  const out: Slicing[] = [];
  for (const e of els) {
    const disc = e.slicing?.discriminator;
    if (!disc) continue;
    const slices: SliceDef[] = [];
    let allSupported = true;
    for (const s of els.filter((x) => x.path === e.path && x.sliceName && x.id?.startsWith(`${e.path}:`))) {
      const min = Number(s.min) || 0;
      const max = s.max === "*" || s.max === undefined ? Infinity : Number(s.max) || 0;
      let supported = true;
      const discriminators: Array<{ path: string; value: unknown }> = [];
      for (const d of disc) {
        if (d.type !== "value" && d.type !== "pattern") { supported = false; break; }
        let val = byId.has(`${s.id}.${d.path}`) ? fixedOrPatternValue(byId.get(`${s.id}.${d.path}`)) : undefined;
        if (val === undefined) {
          const own = fixedOrPatternValue(s);
          if (own !== undefined) val = navigate(own, d.path);
        }
        if (val === undefined || typeof val === "object") { supported = false; break; } // need a scalar
        discriminators.push({ path: d.path, value: val });
      }
      if (supported && discriminators.length) slices.push({ sliceName: s.sliceName, min, max, discriminators });
      else allSupported = false;
    }
    const closed = e.slicing?.rules === "closed" && allSupported && slices.length > 0;
    if (slices.some((s) => s.min >= 1 || s.max !== Infinity) || closed) out.push({ path: e.path, slices, closed });
  }
  return out;
}

/** Validate required slices against a resource. Returns issues for unmet required slices. */
export function validateSlices(resource: Record<string, unknown>, slicings: Slicing[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const rt = String(resource.resourceType);
  for (const sl of slicings) {
    const rel = sl.path.startsWith(`${rt}.`) ? sl.path.slice(rt.length + 1) : sl.path;
    let collection: unknown[];
    try {
      collection = fhirpath.evaluate(resource, rel) as unknown[];
    } catch {
      continue;
    }
    const matchedAny = new Array<boolean>(collection.length).fill(false);
    for (const slice of sl.slices) {
      let count = 0;
      collection.forEach((elem, i) => {
        if (matchesSlice(elem, slice.discriminators)) { count++; matchedAny[i] = true; }
      });
      if (count < slice.min) {
        issues.push({
          path: sl.path,
          message: `required slice '${slice.sliceName}' (min ${slice.min}) not satisfied — found ${count} matching`,
        });
      }
      if (count > slice.max) {
        issues.push({
          path: sl.path,
          message: `slice '${slice.sliceName}' (max ${slice.max}) exceeded — found ${count} matching`,
        });
      }
    }
    // Closed slicing: every element must belong to SOME defined slice (only enforced when
    // every declared slice's discriminators were extractable — see extractSlicings).
    if (sl.closed) {
      const strays = matchedAny.filter((m) => !m).length;
      if (strays > 0) {
        issues.push({
          path: sl.path,
          message: `closed slicing violated — ${strays} element(s) match no defined slice`,
        });
      }
    }
  }
  return issues;
}

function matchesSlice(elem: unknown, discriminators: Array<{ path: string; value: unknown }>): boolean {
  for (const d of discriminators) {
    let vals: unknown[];
    try {
      vals = fhirpath.evaluate(elem as any, d.path) as unknown[];
    } catch {
      return false;
    }
    if (!vals.includes(d.value)) return false;
  }
  return true;
}
