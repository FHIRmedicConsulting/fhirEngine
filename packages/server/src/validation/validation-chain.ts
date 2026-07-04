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

/** Cached per-profile spec from the installed snapshot: required element paths (any depth),
 * profile-tightened required bindings, and slicings. Paths are relative to the resource type. */
interface RequiredBinding { path: string; valueSet: string; fhirType: string }
interface ProfileSpec { required: string[]; requiredBindings: RequiredBinding[]; slicings: Slicing[] }
const profileSpecCache = new Map<string, ProfileSpec>();

async function profileSpec(wh: DeltaWarehouse, url: string): Promise<ProfileSpec> {
  if (profileSpecCache.has(url)) return profileSpecCache.get(url)!;
  let spec: ProfileSpec = { required: [], requiredBindings: [], slicings: [] };
  try {
    wh.registerConformance("structuredefinition");
    const rows = await wh.query<{ json: string }>(
      "SELECT json FROM structuredefinition WHERE url = ? LIMIT 1",
      [url],
    );
    if (rows.length) {
      const sd = JSON.parse(rows[0].json);
      const rtype = sd.type;
      const required = new Set<string>();
      const requiredBindings: RequiredBinding[] = [];
      for (const e of sd.snapshot?.element ?? []) {
        const path = String(e.path ?? "");
        if (path === rtype || !path.startsWith(`${rtype}.`)) continue;
        const rel = path.slice(rtype.length + 1); // path relative to the resource (any depth)
        // Slice-qualified elements constrain only their slice; the qualifier lives in element
        // *id* (`Condition.category:screening`), never in path — applying such a constraint to
        // every node at the path false-rejects valid resources.
        if (String(e.id ?? "").includes(":") || e.sliceName) continue;
        if ((Number(e.min) || 0) >= 1) required.add(rel);
        if (e.binding?.strength === "required" && e.binding?.valueSet) {
          requiredBindings.push({ path: rel, valueSet: String(e.binding.valueSet).split("|")[0], fhirType: e.type?.[0]?.code ?? "" });
        }
      }
      spec = { required: [...required], requiredBindings, slicings: extractSlicings(sd.snapshot ?? { element: [] }) };
    }
  } catch {
    spec = { required: [], requiredBindings: [], slicings: [] };
  }
  profileSpecCache.set(url, spec);
  return spec;
}

/** Operator profile requirement (FHIRENGINE_VALIDATION_PROFILES, comma-separated). Empty
 * (default) → base-FHIR-only validation; `meta.profile` claims are stored, not enforced.
 * Entries: an installed IG package id (enforce its profiles for the resource type, e.g.
 * `hl7.fhir.us.core`), a profile canonical URL, or `declared` (enforce claimed profiles). */
function validationProfileConfig(): string[] {
  return (process.env.FHIRENGINE_VALIDATION_PROFILES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

const configuredProfileCache = new Map<string, string[]>();

async function configuredProfiles(wh: DeltaWarehouse, rt: string, cfg: string[]): Promise<string[]> {
  const key = `${cfg.join(",")}|${rt}`;
  if (configuredProfileCache.has(key)) return configuredProfileCache.get(key)!;
  const out = new Set<string>();
  try {
    wh.registerConformance("structuredefinition");
    for (const entry of cfg) {
      if (entry === "declared") continue; // resolved per-resource by the caller
      const rows = /^https?:\/\//.test(entry)
        ? await wh.query<{ url: string }>(
            "SELECT url FROM structuredefinition WHERE url = ? AND type = ? LIMIT 1",
            [entry.split("|")[0], rt],
          )
        : await wh.query<{ url: string }>(
            "SELECT url FROM structuredefinition WHERE package = ? AND type = ? AND derivation = 'constraint'",
            [entry, rt],
          );
      for (const r of rows) out.add(r.url);
    }
  } catch { /* conformance store absent → nothing to enforce */ }
  const list = [...out];
  configuredProfileCache.set(key, list);
  return list;
}

/** Drop cached profile specs/requirements (tests; after IG install). */
export function resetValidationCaches(): void {
  profileSpecCache.clear();
  configuredProfileCache.clear();
}

/** Descend a dot-path (relative to the root), flattening arrays → the set of nodes at that path.
 * `[x]` choice segments are not descended here (only meaningful as a leaf, handled by callers). */
function nodesAtPath(root: unknown, segs: string[]): unknown[] {
  let cur: unknown[] = [root];
  for (const seg of segs) {
    const next: unknown[] = [];
    for (const node of cur) {
      if (!node || typeof node !== "object") continue;
      const v = (node as Record<string, unknown>)[seg];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) next.push(...v);
      else next.push(v);
    }
    cur = next;
  }
  return cur;
}

/** Missing-required-element issues for a relative path, conditional on parent presence (FHIR:
 * a required nested element only applies where its container is present). Handles arrays + [x]. */
function missingRequired(resource: Record<string, unknown>, rt: string, rel: string, url: string): ValidationIssue[] {
  const segs = rel.split(".");
  const leaf = segs[segs.length - 1]!;
  const parents = segs.length === 1 ? [resource] : nodesAtPath(resource, segs.slice(0, -1));
  const out: ValidationIssue[] = [];
  for (const parent of parents) {
    if (parent && typeof parent === "object" && !elementPresent(parent as Record<string, unknown>, leaf)) {
      out.push({ path: `${rt}.${rel}`, message: `profile ${url} requires element '${rel}'` });
    }
  }
  return out;
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

/** Is a (possibly choice-type) required element present + non-empty on the resource?
 * For a `foo[x]` element, any concrete form satisfies it (e.g. `medication[x]` →
 * `medicationCodeableConcept` | `medicationReference`; `value[x]` → `valueQuantity` …). */
export function elementPresent(resource: Record<string, unknown>, el: string): boolean {
  const nonEmpty = (v: unknown) => !(v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0));
  if (el.endsWith("[x]")) {
    const base = el.slice(0, -3);
    return Object.keys(resource).some(
      (k) => k.length > base.length && k.startsWith(base) && k[base.length] === k[base.length]!.toUpperCase() && nonEmpty(resource[k]),
    );
  }
  return nonEmpty(resource[el]);
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

  // L2–L5 profile: required elements from installed profile snapshots — but ONLY the
  // profiles the OPERATOR requires (FHIRENGINE_VALIDATION_PROFILES). By default nothing is
  // required and validation stops at the installed FHIR version: a resource merely
  // *claiming* a profile in meta.profile is not rejected for missing that profile's
  // constraints (real-world EHR exports routinely stamp profiles they don't fully satisfy).
  // NOTE (must-support): intentionally NOT enforced at the instance level — per FHIR,
  // must-support is a server *capability* (surfaced in CapabilityStatement), not an
  // instance-validity rule; an instance is valid even if it omits a must-support element.
  // NOTE (slicing): full discriminator-based slice validation is deferred (the hard part
  // per the IG-provisioning research) — a wrong slicer false-rejects valid resources; the
  // generated `validateSliceCardinality` helper is the future hook.
  const cfg = validationProfileConfig();
  const profiles: string[] = [];
  if (opts?.warehouse && cfg.length) {
    profiles.push(...(await configuredProfiles(opts.warehouse, rt, cfg)));
    if (cfg.includes("declared")) {
      const declared = ((resource.meta as any)?.profile ?? []) as string[];
      for (const u of declared) if (u && !profiles.includes(u.split("|")[0])) profiles.push(u.split("|")[0]);
    }
  }
  const profileBindingTasks: BindingTask[] = [];
  if (opts?.warehouse && profiles.length) {
    for (const url of profiles) {
      const spec = await profileSpec(opts.warehouse, url);
      // Required elements at ANY depth (conditional on parent presence).
      for (const rel of spec.required) issues.push(...missingRequired(resource, rt, rel, url));
      // Profile-tightened required bindings (this is where US Core CodeableConcept/Coding
      // bindings live — the base R4 schema carries few). Collected here, checked below with
      // the base bindings so the same 3-state (valid / invalid / unknown→pending) applies.
      for (const rb of spec.requiredBindings) {
        if (rb.path.includes("[x]")) continue; // choice-type binding paths deferred
        for (const node of nodesAtPath(resource, rb.path.split("."))) {
          const codings = extractCodings(node, rb.fhirType);
          if (codings.length) profileBindingTasks.push({ path: `${rt}.${rb.path}`, valueSet: rb.valueSet, codings });
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
    const tasks: BindingTask[] = [...profileBindingTasks]; // profile-tightened + base bindings
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
        // quarantine + resolve (FHIRENGINE_QUARANTINE_ON_UNKNOWN); default behavior is unchanged.
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
