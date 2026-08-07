/**
 * Security Labeling Service (SLS) — ADR-0015 Amendment 2 (Layer C-prime).
 *
 * Populates `meta.security[]` on ingested resources from classification rules, so the
 * consent gate / DS4P obligations / `Consent.provision.securityLabel` matching have real
 * labels to enforce (without an SLS they only fire on source-supplied labels).
 *
 * Rule model (subset of ADR-0015 A2.1, operator-extensible):
 *   {
 *     ruleId, resourceType ('*' or a FHIR type),
 *     codeSystem?           — restrict coding matches to this system,
 *     matchValues?          — codes; a trailing '*' makes it a PREFIX ("F1*" covers F10–F19),
 *     matchValueSet?        — canonical of a LOCALLY-expanded ValueSet (valueset_expansion);
 *                             resolved once at configure time,
 *     fieldPath?            — dot path restricting where codings are read ("code",
 *                             "medicationCodeableConcept"); default: every coding in the body,
 *     sensitivity?          — HCS v3-ActCode tags to emit (ETH, PSY, HIV, SUD, SEX, ...),
 *     confidentiality?      — HCS v3-Confidentiality floor to emit (R, V, ...),
 *     jurisdiction?, policyReference? — provenance, carried into audit/debug output.
 *   }
 *
 * Merge policy (A2.5): source labels are PRESERVED; SLS labels are added with (system, code)
 * dedup; confidentiality is a total order (U<L<M<N<R<V) — exactly one tag, highest wins.
 *
 * Enablement: FHIRENGINE_SLS_ENABLED=true. Rules: FHIRENGINE_SLS_RULES (inline JSON array or
 * `@/path/to/rules.json`). A small built-in US-realm demo floor (42 CFR Part 2 ICD-10
 * prefixes, common HIV codes — the ADR's example baseline) is included unless
 * FHIRENGINE_SLS_BASELINE=off; it is DEMONSTRATIVE, not clinically exhaustive — production
 * deployments supply curated jurisdiction/customer rule sets (e.g. VSAC C2S value sets via
 * matchValueSet).
 */
import { readFileSync } from "node:fs";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { logSwallowed } from "../lib/log.js";

export const HCS_CONFIDENTIALITY_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-Confidentiality";
export const HCS_SENSITIVITY_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";

const CONFIDENTIALITY_ORDER = ["U", "L", "M", "N", "R", "V"] as const;
type Confidentiality = (typeof CONFIDENTIALITY_ORDER)[number];

export interface SlsRule {
  ruleId: string;
  resourceType: string; // '*' or a FHIR type
  codeSystem?: string;
  matchValues?: string[];
  matchValueSet?: string;
  fieldPath?: string;
  sensitivity?: string[];
  confidentiality?: string;
  jurisdiction?: string;
  policyReference?: string;
}

/** A rule compiled for sync per-resource evaluation (value sets pre-resolved to codes). */
interface CompiledRule extends SlsRule {
  exact: Set<string>; // "system|code" and bare "code" keys
  prefixes: Array<{ system?: string; prefix: string }>;
}

export const slsEnabled = (): boolean => process.env.FHIRENGINE_SLS_ENABLED === "true";

/** The ADR-0015 A2.1 example baseline (US-realm federal floor) — DEMONSTRATIVE ONLY. */
export const DEMO_BASELINE_RULES: SlsRule[] = [
  {
    ruleId: "42cfr2-sud-icd10", resourceType: "*", codeSystem: "http://hl7.org/fhir/sid/icd-10-cm",
    matchValues: ["F10*", "F11*", "F12*", "F13*", "F14*", "F15*", "F16*", "F18*", "F19*"],
    sensitivity: ["ETH", "SUD"], confidentiality: "R",
    jurisdiction: "42CFRPart2", policyReference: "https://www.ecfr.gov/current/title-42/part-2",
  },
  {
    ruleId: "mh-icd10", resourceType: "*", codeSystem: "http://hl7.org/fhir/sid/icd-10-cm",
    matchValues: ["F2*", "F30*", "F31*", "F32*", "F33*", "F34*", "F39*"],
    sensitivity: ["PSY"], confidentiality: "R", jurisdiction: "HIPAA-state-floor",
  },
  {
    ruleId: "hiv-icd10", resourceType: "*", codeSystem: "http://hl7.org/fhir/sid/icd-10-cm",
    matchValues: ["B20", "Z21"], sensitivity: ["HIV"], confidentiality: "R", jurisdiction: "HIPAA-state-floor",
  },
  {
    ruleId: "hiv-snomed", resourceType: "*", codeSystem: "http://snomed.info/sct",
    matchValues: ["86406008", "165816005", "84971900"], sensitivity: ["HIV"], confidentiality: "R",
    jurisdiction: "HIPAA-state-floor",
  },
];

let compiled: CompiledRule[] = [];
let configured = false;

function parseRulesEnv(): SlsRule[] {
  const raw = process.env.FHIRENGINE_SLS_RULES;
  const fromEnv: SlsRule[] = [];
  if (raw) {
    try {
      const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
      const arr = JSON.parse(text) as SlsRule[];
      if (Array.isArray(arr)) fromEnv.push(...arr);
    } catch (e) {
      logSwallowed("sls:rules-parse", e); // malformed operator rules → baseline only (never half-apply)
    }
  }
  const baseline = process.env.FHIRENGINE_SLS_BASELINE === "off" ? [] : DEMO_BASELINE_RULES;
  return [...baseline, ...fromEnv];
}

function compile(rule: SlsRule, valueSetCodes?: Array<{ system?: string; code: string }>): CompiledRule {
  const exact = new Set<string>();
  const prefixes: Array<{ system?: string; prefix: string }> = [];
  for (const v of rule.matchValues ?? []) {
    if (v.endsWith("*")) prefixes.push({ system: rule.codeSystem, prefix: v.slice(0, -1) });
    else {
      exact.add(rule.codeSystem ? `${rule.codeSystem}|${v}` : v);
      if (rule.codeSystem) exact.add(v); // bare-code fallback when source coding omits the system
    }
  }
  for (const c of valueSetCodes ?? []) {
    exact.add(c.system ? `${c.system}|${c.code}` : c.code);
    exact.add(c.code);
  }
  return { ...rule, exact, prefixes };
}

/**
 * Configure the SLS: parse rules, resolve `matchValueSet` rules against the LOCAL terminology
 * store (valueset_expansion — VSAC pulls / IG installs), and compile for sync application.
 * A value set that isn't loaded logs and disables only that rule (fail closed per rule —
 * a missing expansion must not silently label nothing while looking configured).
 */
export async function configureSls(wh?: DeltaWarehouse): Promise<number> {
  compiled = [];
  for (const rule of parseRulesEnv()) {
    if (rule.matchValueSet) {
      if (!wh) { logSwallowed(`sls:valueset-rule-no-warehouse:${rule.ruleId}`, new Error(rule.matchValueSet)); continue; }
      try {
        wh.registerTerminology("valueset_expansion");
        const rows = await wh.query<{ system: string | null; code: string }>(
          "SELECT system, code FROM valueset_expansion WHERE valueset = ?", [rule.matchValueSet]);
        if (!rows.length) { logSwallowed(`sls:valueset-empty:${rule.ruleId}`, new Error(rule.matchValueSet)); continue; }
        compiled.push(compile(rule, rows.map((r) => ({ system: r.system ?? undefined, code: r.code }))));
      } catch (e) {
        logSwallowed(`sls:valueset-resolve:${rule.ruleId}`, e);
      }
    } else {
      compiled.push(compile(rule));
    }
  }
  configured = true;
  return compiled.length;
}

/** Test helper / reset. */
export function resetSls(): void { compiled = []; configured = false; }

/** Walk a dot path; arrays fan out. Returns the nodes at the path. */
function nodesAt(resource: Record<string, unknown>, path: string): unknown[] {
  let nodes: unknown[] = [resource];
  for (const seg of path.split(".")) {
    const next: unknown[] = [];
    for (const n of nodes) {
      if (n == null || typeof n !== "object") continue;
      const v = (n as Record<string, unknown>)[seg];
      if (v == null) continue;
      next.push(...(Array.isArray(v) ? v : [v]));
    }
    nodes = next;
  }
  return nodes;
}

/** Collect every {system?, code} Coding pair under the given roots (deep walk). */
function collectCodings(roots: unknown[]): Array<{ system?: string; code: string }> {
  const out: Array<{ system?: string; code: string }> = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.code === "string" && (o.system === undefined || typeof o.system === "string")) {
      out.push({ system: o.system as string | undefined, code: o.code });
    }
    for (const k of Object.keys(o)) if (k !== "meta") walk(o[k]); // never match on existing labels
  };
  roots.forEach(walk);
  return out;
}

function ruleMatches(rule: CompiledRule, resource: Record<string, unknown>): boolean {
  if (rule.resourceType !== "*" && rule.resourceType !== resource.resourceType) return false;
  const roots = rule.fieldPath ? nodesAt(resource, rule.fieldPath) : [resource];
  for (const c of collectCodings(roots)) {
    if (rule.codeSystem && c.system && c.system !== rule.codeSystem) continue;
    const keys = c.system ? [`${c.system}|${c.code}`, c.code] : [c.code];
    if (keys.some((k) => rule.exact.has(k))) return true;
    if (rule.prefixes.some((p) => c.code.startsWith(p.prefix) && (!p.system || !c.system || c.system === p.system))) return true;
  }
  return false;
}

const confRank = (code: string): number => CONFIDENTIALITY_ORDER.indexOf(code as Confidentiality);

export interface SlsResult {
  labeled: boolean;
  matchedRules: string[];
}

/**
 * Apply the configured rules to a resource IN PLACE (sync — rules are pre-compiled).
 * Merge per A2.5: source labels preserved, (system, code) dedup, single highest-wins
 * confidentiality tag. No-op when the SLS is disabled or unconfigured.
 */
export function applySecurityLabels(resource: Record<string, unknown>): SlsResult {
  if (!slsEnabled() || !configured || !compiled.length) return { labeled: false, matchedRules: [] };

  const matched = compiled.filter((r) => ruleMatches(r, resource));
  if (!matched.length) return { labeled: false, matchedRules: [] };

  const meta = (resource.meta ?? {}) as Record<string, unknown>;
  const security = Array.isArray(meta.security) ? [...(meta.security as Array<Record<string, unknown>>)] : [];

  const have = new Set(security.map((l) => `${l.system ?? ""}|${l.code ?? ""}`));
  let changed = false;

  // Sensitivity tags: union across matched rules (A2.1 conflict resolution).
  for (const rule of matched) {
    for (const tag of rule.sensitivity ?? []) {
      const key = `${HCS_SENSITIVITY_SYSTEM}|${tag}`;
      if (have.has(key)) continue;
      have.add(key);
      security.push({ system: HCS_SENSITIVITY_SYSTEM, code: tag });
      changed = true;
    }
  }

  // Confidentiality: total order, highest wins, exactly one tag.
  const emitted = matched.map((r) => r.confidentiality).filter((c): c is string => !!c && confRank(c) >= 0);
  if (emitted.length) {
    const target = emitted.reduce((a, b) => (confRank(b) > confRank(a) ? b : a));
    const existing = security.filter((l) => l.system === HCS_CONFIDENTIALITY_SYSTEM && confRank(String(l.code)) >= 0);
    const existingMax = existing.length ? existing.reduce((a, b) => (confRank(String(b.code)) > confRank(String(a.code)) ? b : a)) : null;
    if (!existingMax || confRank(target) > confRank(String(existingMax.code))) {
      const keep = security.filter((l) => l.system !== HCS_CONFIDENTIALITY_SYSTEM);
      keep.push({ system: HCS_CONFIDENTIALITY_SYSTEM, code: target });
      security.length = 0;
      security.push(...keep);
      changed = true;
    }
  }

  if (changed) {
    meta.security = security;
    resource.meta = meta;
  }
  return { labeled: changed, matchedRules: matched.map((r) => r.ruleId) };
}
