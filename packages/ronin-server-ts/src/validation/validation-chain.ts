/**
 * ValidationSupportChain (TS) — the shared-tier FHIR validator (HAPI-style chain),
 * run IN-PROCESS prior to Bronze. Layers:
 *   L1/L2 structural  — vendored R4 columnar registry (required + shape)
 *   L2–L5 profile     — required-elements from INSTALLED profile snapshots (conformance store)
 *   L3 bindings       — (future) terminology $validate-code on required bindings
 * Replaces the Python-sidecar validation (which forked from Ronin); the sidecar becomes
 * a pure writer. See docs/research/2026-06-28-fhir-validation-approach-comparison.md.
 */
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { schemaFor, isR4CoreResource, constraintsFor } from "../fhir-schema/r4-registry.js";
import { validateStructural, type ValidationIssue } from "./structural-validator.js";
import { validateInvariants } from "./invariant-validator.js";
import { validateCode } from "../terminology/validate-code.js";
import { extractSlicings, validateSlices, type Slicing } from "./slice-validator.js";
import type { Column } from "../fhir-schema/clean-room-flattener.js";

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Unknown (not-loaded) value sets encountered — resolvable terminology, not invalid.
   * Drives quarantine-and-resolve when enabled; `valid` stays true (graceful default). */
  pending?: Array<{ valueSet: string; path: string }>;
}

/** Cached per-profile spec from the installed snapshot: required top-level elements + slicings. */
interface ProfileSpec { required: string[]; slicings: Slicing[] }
const profileSpecCache = new Map<string, ProfileSpec>();

async function profileSpec(wh: DeltaWarehouse, url: string): Promise<ProfileSpec> {
  if (profileSpecCache.has(url)) return profileSpecCache.get(url)!;
  let spec: ProfileSpec = { required: [], slicings: [] };
  try {
    wh.registerConformance("structuredefinition");
    const rows = await wh.query<{ json: string }>(
      "SELECT json FROM structuredefinition WHERE url = ? LIMIT 1",
      [url],
    );
    if (rows.length) {
      const sd = JSON.parse(rows[0].json);
      const rtype = sd.type;
      const required: string[] = [];
      for (const e of sd.snapshot?.element ?? []) {
        const segs = (e.path ?? "").split(".");
        if (segs.length === 2 && segs[0] === rtype && (Number(e.min) || 0) >= 1) required.push(segs[1]);
      }
      spec = { required, slicings: extractSlicings(sd.snapshot ?? { element: [] }) };
    }
  } catch {
    spec = { required: [], slicings: [] };
  }
  profileSpecCache.set(url, spec);
  return spec;
}

/** Synchronous structural-only validation (L1/L2) — no warehouse, in-process. */
export function validateStructuralOnly(resource: Record<string, unknown>): ValidationResult {
  const rt = String(resource.resourceType ?? "");
  if (!isR4CoreResource(rt)) {
    return { valid: false, issues: [{ path: "resourceType", message: `unknown R4 Core resource type '${rt}'` }] };
  }
  const issues = validateStructural(resource, schemaFor(rt));
  // L4 — FHIRPath invariants (pure, no warehouse).
  issues.push(...validateInvariants(resource, constraintsFor(rt)));
  return { valid: issues.length === 0, issues };
}

/** Full chain: structural + profile (required-elements from installed snapshots). */
export async function validateResource(
  resource: Record<string, unknown>,
  opts?: { warehouse?: DeltaWarehouse },
): Promise<ValidationResult> {
  const rt = String(resource.resourceType);
  const base = validateStructuralOnly(resource);
  const issues = [...base.issues];
  if (!isR4CoreResource(rt)) return { valid: issues.length === 0, issues };

  // L2–L5 profile: required elements from installed profile snapshots.
  // NOTE (must-support): intentionally NOT enforced at the instance level — per FHIR,
  // must-support is a server *capability* (surfaced in CapabilityStatement), not an
  // instance-validity rule; an instance is valid even if it omits a must-support element.
  // NOTE (slicing): full discriminator-based slice validation is deferred (the hard part
  // per the IG-provisioning research) — a wrong slicer false-rejects valid resources; the
  // generated `validateSliceCardinality` helper is the future hook.
  const profiles = ((resource.meta as any)?.profile ?? []) as string[];
  if (opts?.warehouse && profiles.length) {
    for (const url of profiles) {
      const spec = await profileSpec(opts.warehouse, url);
      for (const el of spec.required) {
        const v = (resource as any)[el];
        if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
          issues.push({ path: `${rt}.${el}`, message: `profile ${url} requires element '${el}'` });
        }
      }
      // Slicing — required value/pattern-discriminated slices.
      issues.push(...validateSlices(resource, spec.slicings));
    }
  }

  // L3 bindings: required bindings on code / Coding / CodeableConcept, at ANY depth,
  // checked against loaded ValueSets. CodeableConcept valid if ≥1 coding is in the VS;
  // "unknown" (ValueSet not loaded) degrades to a skip (warning), not a failure.
  const pending: Array<{ valueSet: string; path: string }> = [];
  if (opts?.warehouse) {
    const tasks: BindingTask[] = [];
    collectBindings(resource, schemaFor(rt), rt, tasks);
    for (const task of tasks) {
      let anyValid = false, anyInvalid = false, anyUnknown = false;
      for (const cd of task.codings) {
        if (!cd.code) continue;
        try {
          const res = await validateCode(opts.warehouse, { valueSet: task.valueSet, code: cd.code, system: cd.system });
          if (res.status === "valid") anyValid = true;
          else if (res.status === "invalid") anyInvalid = true;
          else anyUnknown = true; // ValueSet not loaded
        } catch {
          anyUnknown = true; // terminology store absent/unreadable → unknown, not a failure
        }
      }
      if (anyValid) continue;
      if (anyInvalid) {
        issues.push({ path: task.path, message: `no coding in required ValueSet ${task.valueSet}` });
      } else if (anyUnknown) {
        // Resolvable terminology not loaded → record (graceful: still valid). The caller may
        // quarantine + resolve (RONIN_QUARANTINE_ON_UNKNOWN); default behavior is unchanged.
        pending.push({ valueSet: task.valueSet, path: task.path });
      }
    }
  }

  return { valid: issues.length === 0, issues, pending: pending.length ? pending : undefined };
}

interface BindingTask { path: string; valueSet: string; codings: Array<{ system?: string; code?: string }> }

/** Recursively collect required-binding tasks from a resource against its schema tree. */
function collectBindings(obj: any, cols: Column[], path: string, tasks: BindingTask[]): void {
  if (!obj || typeof obj !== "object") return;
  for (const c of cols) {
    const v = obj[c.name];
    if (v === undefined || v === null) continue;
    if (c.binding) {
      const items = c.list ? (Array.isArray(v) ? v : [v]) : [v];
      for (const item of items) {
        const codings = extractCodings(item, c.fhirType);
        if (codings.length) tasks.push({ path: `${path}.${c.name}`, valueSet: c.binding, codings });
      }
    } else if (c.type.kind === "struct") {
      const items = c.list ? (Array.isArray(v) ? v : []) : [v];
      items.forEach((it: unknown, i: number) => {
        if (it && typeof it === "object") {
          collectBindings(it, (c.type as any).fields, c.list ? `${path}.${c.name}[${i}]` : `${path}.${c.name}`, tasks);
        }
      });
    }
  }
}

/** Pull (system, code) pairs from a value by its FHIR type for binding validation. */
function extractCodings(v: unknown, fhirType: string): Array<{ system?: string; code?: string }> {
  if (fhirType === "code") return typeof v === "string" ? [{ code: v }] : [];
  if (fhirType === "Coding") {
    const c = v as { system?: string; code?: string };
    return c && typeof c === "object" ? [{ system: c.system, code: c.code }] : [];
  }
  if (fhirType === "CodeableConcept") {
    const cc = v as { coding?: Array<{ system?: string; code?: string }> };
    return Array.isArray(cc?.coding) ? cc.coding.map((cd) => ({ system: cd.system, code: cd.code })) : [];
  }
  return [];
}
