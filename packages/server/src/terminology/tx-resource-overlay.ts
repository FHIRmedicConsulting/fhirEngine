/**
 * tx-resource overlay — request-scoped terminology supplied BY THE CLIENT.
 *
 * The HL7 validator ecosystem ("CodeSystemAsParameter" feature,
 * http://hl7.org/fhir/uv/tx-ecosystem/FeatureDefinition/CodeSystemAsParameter)
 * sends IG-carried CodeSystem/ValueSet resources inline in the `tx-resource`
 * parameter of $validate-code / $expand, so a tx server can answer about
 * terminology it has never had installed. This module evaluates those
 * resources in memory; the routes consult the overlay FIRST and fall back to
 * the Delta-backed store for anything the overlay doesn't know.
 *
 * `cache-id` sessions: the client may send resources once per session and
 * omit them on later calls. Sessions are held in-process (single-node server)
 * in a small insertion-ordered cache.
 *
 * Version semantics (tx-ecosystem "version" battery): CodeSystems may be
 * supplied in several versions under one url. ValueSet includes may pin a
 * version (exact or `x`-wildcard), and the request may carry
 * system-version / check-system-version / force-system-version parameters.
 * Resolution + the battery's exact error contract live here (see tx-version.ts
 * for the matching rules).
 */

import {
  type VersionParams,
  emptyVersionParams,
  versionMatches,
  compareVersions,
  pickLatest,
  versionList,
} from "./tx-version.js";

export { emptyVersionParams, parseVersionParams, type VersionParams } from "./tx-version.js";

interface Designation { language?: string; use?: { system?: string; code?: string; display?: string }; value: string }

export interface OverlayConcept {
  code: string;
  display?: string;
  definition?: string;
  parent?: string;
  children: string[];
  designations: Designation[];
  /** property code -> values (from CodeSystem.concept.property value[x]) */
  properties: Record<string, unknown[]>;
  /** original concept.property objects (typed value[x] preserved for expansion echoes) */
  rawProps: any[];
}

interface CodeSystemIndex {
  url: string;
  version?: string;
  caseSensitive: boolean;
  content?: string;
  resource: any;
  concepts: Map<string, OverlayConcept>; // keyed by code (exact case)
  byLowerCode: Map<string, string>; // lower(code) -> code, for caseSensitive=false
  /** canonical concept-property name (notSelectable/status/inactive/deprecated)
   * -> the property code this CodeSystem declares for it (resolved by uri) */
  canonicalProps: Record<string, string>;
  /** declared property code -> uri (for expansion.property declarations) */
  propUris: Record<string, string>;
}

export interface ExpandOptions {
  count?: number;
  offset?: number;
  textFilter?: string;
  activeOnly?: boolean;
  excludeNested?: boolean;
  includeDesignations?: boolean;
  /** property codes requested via the `property` parameter */
  properties?: string[];
  versionParams?: VersionParams;
  /** Explicit ValueSet version request (url|v or valueSetVersion param). */
  valueSetVersion?: string;
}

export interface ContainsEntry {
  system: string;
  code: string;
  display?: string;
  abstract?: boolean;
  inactive?: boolean;
  version?: string;
}

/** One issue in the battery's exact error contract. `element` is the logical
 * source element; the route maps it onto the input kind's path (e.g.
 * "version" -> "Coding.version" / "CodeableConcept.coding[0].version"). */
export interface TxIssueSpec {
  msgId?: string;
  issueCode: string;
  txType: string;
  text: string;
  element?: "version" | "system" | "code" | "display" | "coding" | "none";
  severity?: "error" | "warning" | "information";
}

export interface RichValidation {
  result: boolean;
  code?: string;
  system?: string;
  version?: string;
  display?: string;
  issues: TxIssueSpec[];
  /** canonical for the x-caused-by-unknown-system response parameter */
  causedByUnknown?: string;
  /** canonical for the x-unknown-system response parameter (system not supplied at all) */
  unknownSystem?: string;
  /** the ValueSet include pinned a version we don't have (drives CC echo quirks) */
  pinUnknown?: boolean;
  /** the matched concept is inactive (emitted as the `inactive` response parameter) */
  inactive?: boolean;
}

export type TxExpandError =
  | { kind: "vs-not-found"; canonical: string }
  | { kind: "unknown-version"; system: string; version: string; valid: string }
  | { kind: "check-violation"; system: string; version: string; pattern: string }
  | { kind: "not-expandable"; text: string };

// --- exact message templates (tx.fhir.org-compatible; the battery diffs them) ---

export const txMessages = {
  unknownVersion: (s: string, v: string, valid: string) =>
    `A definition for CodeSystem '${s}' version '${v}' could not be found, so the code cannot be validated. Valid versions: ${valid}`,
  unknownVersionNone: (s: string, v: string) =>
    `A definition for CodeSystem '${s}' version '${v}' could not be found, so the code cannot be validated. No versions of this code system are known`,
  unknownSystem: (s: string) =>
    `A definition for CodeSystem '${s}' could not be found, so the code cannot be validated`,
  versionMismatchDefault: (s: string, resolved: string, codingV: string) =>
    `The code system '${s}' version '${resolved}' for the versionless include in the ValueSet include is different to the one in the value ('${codingV}')`,
  versionMismatchChanged: (s: string, pattern: string, includePin: string, codingV: string) =>
    `The code system '${s}' version '${pattern}' resulting from the version '${includePin}' in the ValueSet include is different to the one in the value ('${codingV}')`,
  unknownVersionExpand: (s: string, v: string, valid: string) =>
    `A definition for CodeSystem '${s}' version '${v}' could not be found, so the value set cannot be expanded. Valid versions: ${valid}`,
  versionMismatch: (s: string, incV: string, codingV: string) =>
    `The code system '${s}' version '${incV}' in the ValueSet include is different to the one in the value ('${codingV}')`,
  checkViolation: (v: string, s: string, pattern: string) =>
    `The version '${v}' is not allowed for system '${s}': required to be '${pattern}' by a version-check parameter`,
  vsNotFound: (canonical: string) => `A definition for the value Set '${canonical}' could not be found`,
};

function indexConcepts(cs: any): CodeSystemIndex {
  const canonicalProps: Record<string, string> = {};
  const propUris: Record<string, string> = {};
  for (const pd of cs.property ?? []) {
    if (pd.uri) propUris[pd.code] = pd.uri;
    const frag = String(pd.uri ?? "").split("#")[1];
    for (const name of ["notSelectable", "status", "inactive", "deprecated"]) {
      if (frag === name || pd.code === name) canonicalProps[name] ??= pd.code;
    }
  }
  for (const name of ["notSelectable", "status", "inactive", "deprecated"]) canonicalProps[name] ??= name;
  const idx: CodeSystemIndex = {
    url: cs.url,
    version: cs.version,
    caseSensitive: cs.caseSensitive !== false,
    content: cs.content,
    resource: cs,
    concepts: new Map(),
    byLowerCode: new Map(),
    canonicalProps,
    propUris,
  };
  const walk = (concepts: any[], parent?: string) => {
    for (const c of concepts ?? []) {
      const entry: OverlayConcept = {
        code: c.code,
        display: c.display,
        definition: c.definition,
        parent,
        children: (c.concept ?? []).map((k: any) => k.code),
        designations: (c.designation ?? []).map((d: any) => ({ language: d.language, use: d.use, value: d.value })),
        properties: {},
        rawProps: c.property ?? [],
      };
      for (const pr of c.property ?? []) {
        const value = pr.valueCode ?? pr.valueBoolean ?? pr.valueString ?? pr.valueInteger ?? pr.valueCoding?.code;
        (entry.properties[pr.code] ??= []).push(value);
      }
      idx.concepts.set(c.code, entry);
      idx.byLowerCode.set(String(c.code).toLowerCase(), c.code);
      walk(c.concept ?? [], c.code);
    }
  };
  walk(cs.concept ?? []);
  return idx;
}

function conceptInactive(concept: OverlayConcept, cs?: CodeSystemIndex): boolean {
  const p = (name: string) => concept.properties[cs?.canonicalProps[name] ?? name]?.[0];
  const status = p("status");
  return p("inactive") === true || status === "retired" || status === "deprecated" || p("deprecated") === true;
}

function conceptAbstract(concept: OverlayConcept, cs?: CodeSystemIndex): boolean {
  return concept.properties[cs?.canonicalProps["notSelectable"] ?? "notSelectable"]?.[0] === true;
}

/** Per-clause version resolution outcome (validate + expand share this). */
interface ClauseResolution {
  /** resolved concrete version (undefined for a version-less CodeSystem) */
  version?: string;
  cs?: CodeSystemIndex;
  /** raw include pin that could not be resolved */
  unknownPin?: string;
  /** effective pin: include pin (resolved) or forced version */
  pinned?: string;
  /** raw pin string for messages ('1', '1.2.0', …) */
  pinnedRaw?: string;
  pinnedIsWildcard?: boolean;
  forced?: boolean;
  /** which request params were actually applied (for expansion echoes) */
  appliedForce?: boolean;
  appliedCheck?: boolean;
  appliedDefault?: boolean;
  /** check-system-version violated by the resolved version */
  checkViolation?: { version: string; pattern: string };
}

interface ExpandContext {
  vparams: VersionParams;
  /** system url -> set of resolved versions ("" for version-less) */
  used: Map<string, Set<string>>;
  applied: { force: Set<string>; check: Set<string>; deflt: Set<string> };
  error?: TxExpandError;
}

const isWildcard = (p: string) => /(^|\.)[xX](\.|$)/.test(p);

export class TxOverlay {
  private codeSystems = new Map<string, CodeSystemIndex[]>(); // url -> versions (ascending)
  private valueSets = new Map<string, any[]>(); // url -> versions (ascending)
  /** supplemented-system url -> supplement CodeSystem resources */
  private supplements = new Map<string, any[]>();

  register(resource: any): void {
    if (!resource?.url) return;
    if (resource.resourceType === "CodeSystem" && resource.content === "supplement") {
      // supplements never join the regular version list (they'd hijack
      // latest-version resolution); they attach to the supplemented system
      const target = String(resource.supplements ?? "").split("|")[0];
      if (target) {
        const list = this.supplements.get(target) ?? [];
        if (!list.some((x) => x.url === resource.url && x.version === resource.version)) list.push(resource);
        this.supplements.set(target, list);
      }
      return;
    }
    if (resource.resourceType === "CodeSystem") {
      const list = this.codeSystems.get(resource.url) ?? [];
      if (!list.some((x) => x.version === resource.version)) {
        list.push(indexConcepts(resource));
        list.sort((a, b) => compareVersions(a.version ?? "", b.version ?? ""));
      }
      this.codeSystems.set(resource.url, list);
    } else if (resource.resourceType === "ValueSet") {
      const list = this.valueSets.get(resource.url) ?? [];
      if (!list.some((x) => x.version === resource.version)) {
        list.push(resource);
        list.sort((a, b) => compareVersions(a.version ?? "", b.version ?? ""));
      }
      this.valueSets.set(resource.url, list);
    }
  }

  get empty(): boolean {
    return this.codeSystems.size === 0 && this.valueSets.size === 0;
  }

  versionsOf(url: string): (string | undefined)[] {
    return (this.codeSystems.get(url) ?? []).map((x) => x.version);
  }

  csIndex(url: string, version?: string): CodeSystemIndex | undefined {
    const list = this.codeSystems.get(url);
    if (!list?.length) return undefined;
    return version === undefined ? list[list.length - 1] : list.find((x) => x.version === version);
  }

  /** Split a canonical `url|version` and find the resource; no version → latest supplied. */
  codeSystem(canonical: string | undefined): CodeSystemIndex | undefined {
    if (!canonical) return undefined;
    const [url, version] = canonical.split("|");
    return this.csIndex(url, version || undefined);
  }

  hasValueSetUrl(url: string): boolean {
    return (this.valueSets.get(url)?.length ?? 0) > 0;
  }

  valueSet(canonical: string | undefined, explicitVersion?: string): any | undefined {
    if (!canonical) return undefined;
    const [url, urlVersion] = canonical.split("|");
    const version = explicitVersion ?? (urlVersion || undefined);
    const list = this.valueSets.get(url);
    if (!list?.length) return undefined;
    return version === undefined ? list[list.length - 1] : list.find((x) => x.version === version);
  }

  private lookupConcept(cs: CodeSystemIndex, code: string): OverlayConcept | undefined {
    const direct = cs.concepts.get(code);
    if (direct || cs.caseSensitive) return direct;
    const canonical = cs.byLowerCode.get(code.toLowerCase());
    return canonical !== undefined ? cs.concepts.get(canonical) : undefined;
  }

  /** Resolve which CodeSystem version one compose clause uses.
   * `codingVersion` (validate only) lets a wildcard pin land on the value's version. */
  private resolveClause(system: string, clausePin: string | undefined, vparams: VersionParams, codingVersion?: string): ClauseResolution {
    const versions = this.versionsOf(system);
    const known = versions.filter((v): v is string => v !== undefined);
    const F = vparams.force.get(system);
    const K = vparams.check.get(system);
    const D = vparams.deflt.get(system);
    const r: ClauseResolution = {};
    if (F !== undefined) {
      const v = pickLatest(versions, F);
      r.appliedForce = true;
      if (v !== undefined) {
        r.version = v;
        r.pinned = v;
        r.pinnedRaw = v;
        r.forced = true;
        r.cs = this.csIndex(system, v);
        return r;
      }
      r.unknownPin = F;
    } else if (clausePin !== undefined) {
      if (known.includes(clausePin)) {
        r.version = clausePin;
        r.pinned = clausePin;
        r.pinnedRaw = clausePin;
      } else if (isWildcard(clausePin) && pickLatest(versions, clausePin) !== undefined) {
        const v =
          codingVersion !== undefined && versionMatches(clausePin, codingVersion) && known.includes(codingVersion)
            ? codingVersion
            : pickLatest(versions, clausePin)!;
        r.version = v;
        r.pinned = v;
        r.pinnedRaw = clausePin;
        r.pinnedIsWildcard = true;
      } else if (versions.length === 1 && versions[0] === undefined && clausePin === undefined) {
        // unreachable; version-less handled below
      } else {
        r.unknownPin = clausePin;
      }
    }
    if (r.version === undefined && r.unknownPin === undefined) {
      // no pin: default param, else check acts as a pin, else latest
      if (D !== undefined && known.includes(D)) {
        r.version = D;
        r.appliedDefault = true;
      } else if (K !== undefined && pickLatest(versions, K) !== undefined) {
        r.version = pickLatest(versions, K);
        r.appliedCheck = true;
      } else {
        r.version = known.length ? pickLatest(versions) : undefined;
      }
    }
    if (r.unknownPin !== undefined && r.version === undefined) {
      // fallback resolution for echoes when the pin is unknown
      if (D !== undefined && known.includes(D)) r.version = D;
      else if (K !== undefined && pickLatest(versions, K) !== undefined) r.version = pickLatest(versions, K);
      else r.version = known.length ? pickLatest(versions) : undefined;
    }
    r.cs = r.version !== undefined ? this.csIndex(system, r.version) : this.csIndex(system);
    if (K !== undefined && r.unknownPin === undefined && !r.appliedCheck && r.version !== undefined && !versionMatches(K, r.version)) {
      r.checkViolation = { version: r.version, pattern: K };
    }
    return r;
  }

  /** All codes matching one compose include/exclude clause, in definition order.
   * `visiting` is the in-progress ValueSet recursion stack (circular-import guard). */
  private clauseCodes(clause: any, visiting: Set<string>, ctx: ExpandContext): ContainsEntry[] | null {
    // include.valueSet: union across the referenced VS (intersected with the
    // system clause when both are present, per the spec).
    let imported: Set<string> | null = null;
    if (clause.valueSet?.length) {
      imported = new Set<string>();
      for (const vsRef of clause.valueSet) {
        const inner = this.valueSet(vsRef);
        if (!inner) return null; // unknown import → cannot expand this clause
        const entries = this.expandCompose(inner, visiting, ctx);
        if (entries === null) return null;
        for (const e of entries) imported.add(`${e.system}|${e.code}`);
      }
      if (!clause.system) {
        const out: ContainsEntry[] = [];
        for (const key of imported) {
          const [system, code] = key.split("|");
          const cs = this.codeSystem(system);
          const concept = cs ? this.lookupConcept(cs, code) : undefined;
          out.push({ system, code, ...(concept?.display ? { display: concept.display } : {}) });
        }
        return out;
      }
    }
    const res = this.resolveClause(clause.system, clause.version, ctx.vparams);
    if (res.appliedForce) ctx.applied.force.add(clause.system);
    if (res.appliedCheck) ctx.applied.check.add(clause.system);
    if (res.appliedDefault) ctx.applied.deflt.add(clause.system);
    if (res.unknownPin !== undefined) {
      ctx.error ??= {
        kind: "unknown-version",
        system: clause.system,
        version: res.unknownPin,
        valid: versionList(this.versionsOf(clause.system)),
      };
      return null;
    }
    if (res.checkViolation) {
      ctx.error ??= {
        kind: "check-violation",
        system: clause.system,
        version: res.checkViolation.version,
        pattern: res.checkViolation.pattern,
      };
      return null;
    }
    const cs = res.cs;
    if (!cs) return null; // system not in overlay → caller falls back / errors
    (ctx.used.get(cs.url) ?? ctx.used.set(cs.url, new Set()).get(cs.url)!).add(cs.version ?? "");
    let entries: ContainsEntry[];
    if (clause.concept?.length) {
      entries = clause.concept.map((c: any) => {
        const known = this.lookupConcept(cs, c.code);
        const display = c.display ?? known?.display;
        return {
          system: cs.url,
          code: c.code,
          ...(display ? { display } : {}),
          ...(known && conceptAbstract(known, cs) ? { abstract: true } : {}),
          ...(known && conceptInactive(known, cs) ? { inactive: true } : {}),
          ...(cs.version ? { version: cs.version } : {}),
        };
      });
    } else {
      entries = [...cs.concepts.values()].map((concept) => ({
        system: cs.url,
        code: concept.code,
        ...(concept.display ? { display: concept.display } : {}),
        ...(conceptAbstract(concept, cs) ? { abstract: true } : {}),
        ...(conceptInactive(concept, cs) ? { inactive: true } : {}),
        ...(cs.version ? { version: cs.version } : {}),
      }));
    }
    for (const f of clause.filter ?? []) {
      const matches = this.filterMatcher(cs, f);
      if (!matches) return null; // unsupported filter op
      entries = entries.filter((e) => matches(e.code));
    }
    if (imported) entries = entries.filter((e) => imported.has(`${e.system}|${e.code}`));
    return entries;
  }

  /** Predicate for one compose filter, or null when the op isn't supported. */
  private filterMatcher(cs: CodeSystemIndex, f: any): ((code: string) => boolean) | null {
    const descendants = (root: string, includeSelf: boolean): Set<string> => {
      const out = new Set<string>();
      const stack = includeSelf ? [root] : [...(cs.concepts.get(root)?.children ?? [])];
      while (stack.length) {
        const code = stack.pop()!;
        if (out.has(code)) continue;
        out.add(code);
        for (const child of cs.concepts.get(code)?.children ?? []) stack.push(child);
      }
      return out;
    };
    switch (f.op) {
      case "is-a": { const set = descendants(f.value, true); return (code) => set.has(code); }
      case "descendent-of": { const set = descendants(f.value, false); return (code) => set.has(code); }
      case "child-of": { const kids = new Set(cs.concepts.get(f.value)?.children ?? []); return (code) => kids.has(code); }
      case "regex": {
        // ReDoS guard: a quantified group followed by another quantifier is
        // exponential under JS backtracking — the tx-ecosystem regex-bad suite
        // sends (a+)+ / ((a+)+)+ against 56-char codes precisely to wedge
        // servers (a sync .test() cannot be interrupted; this froze the event
        // loop for good). Those patterns are evaluated with a backtracking-free
        // literal-run fallback instead (the battery's bad regexes reduce to
        // "all-a runs" checks); anything else oversized is refused.
        if (f.value.length > 256) return null;
        if (/\([^()]*[+*{][^()]*\)\s*[+*?{]/.test(f.value)) {
          const runMatch = safeNestedQuantifierMatcher(f.value);
          return runMatch ?? null;
        }
        try { const re = new RegExp(`^(?:${f.value})$`); return (code) => re.test(code); }
        catch { return () => false; } // invalid regex matches nothing (regex-bad tests)
      }
      case "=": return (code) => {
        const c = this.lookupConcept(cs, code);
        return f.property === "concept" ? code === f.value : c?.properties[f.property]?.[0] === f.value || String(c?.properties[f.property]?.[0]) === f.value;
      };
      case "in": { const set = new Set(String(f.value).split(",")); return (code) => set.has(code) || set.has(String(this.lookupConcept(cs, code)?.properties[f.property]?.[0])); }
      case "not-in": { const set = new Set(String(f.value).split(",")); return (code) => !set.has(code) && !set.has(String(this.lookupConcept(cs, code)?.properties[f.property]?.[0])); }
      case "exists": return (code) => (this.lookupConcept(cs, code)?.properties[f.property] !== undefined) === (String(f.value) !== "false");
      default: return null;
    }
  }

  /** Full (unpaged, unfiltered) expansion of a ValueSet's compose. Null = not
   * expandable here. `visiting` guards against circular imports (the battery's
   * big-circle cases): a VS already on the recursion stack cannot be entered
   * again; entries are removed on exit so diamond-shaped imports still work. */
  private expandCompose(vs: any, visiting: Set<string> = new Set(), ctx?: ExpandContext): ContainsEntry[] | null {
    ctx ??= { vparams: emptyVersionParams(), used: new Map(), applied: { force: new Set(), check: new Set(), deflt: new Set() } };
    const stackKey = vs.version ? `${vs.url}|${vs.version}` : String(vs.url);
    if (visiting.has(stackKey)) return null; // circular import → cannot expand
    visiting.add(stackKey);
    try {
      const out: ContainsEntry[] = [];
      const seen = new Set<string>();
      for (const inc of vs.compose?.include ?? []) {
        const entries = this.clauseCodes(inc, visiting, ctx);
        if (entries === null) return null;
        for (const e of entries) {
          const key = `${e.system}|${e.version ?? ""}|${e.code}`;
          if (!seen.has(key)) { seen.add(key); out.push(e); }
        }
      }
      for (const exc of vs.compose?.exclude ?? []) {
        const entries = this.clauseCodes(exc, visiting, ctx);
        if (entries === null) return null;
        for (const e of entries) {
          const key = `${e.system}|${e.version ?? ""}|${e.code}`;
          const at = out.findIndex((x) => `${x.system}|${x.version ?? ""}|${x.code}` === key);
          if (at >= 0) { out.splice(at, 1); seen.delete(key); }
        }
      }
      return out;
    } finally {
      visiting.delete(stackKey);
    }
  }

  /** $expand over an overlay ValueSet. Returns the ValueSet echo + expansion, or a typed error. */
  expand(vs: any, opts: ExpandOptions): { valueSet?: any; error?: TxExpandError } {
    const ctx: ExpandContext = {
      vparams: opts.versionParams ?? emptyVersionParams(),
      used: new Map(),
      applied: { force: new Set(), check: new Set(), deflt: new Set() },
    };
    let entries = this.expandCompose(vs, new Set(), ctx);
    if (entries === null) {
      return { error: ctx.error ?? { kind: "not-expandable", text: `ValueSet ${vs.url} cannot be expanded from supplied resources` } };
    }
    if (opts.activeOnly) entries = entries.filter((e) => !e.inactive);
    if (opts.textFilter) {
      const t = opts.textFilter.toLowerCase();
      entries = entries.filter((e) => e.code.toLowerCase().includes(t) || e.display?.toLowerCase().includes(t));
    }
    const total = entries.length;

    // per-entry enrichment: designations (opt-in) + property echoes (requested
    // codes; `status` rides along whenever the concept declares it)
    const emittedProps = new Map<string, string>(); // property code -> uri
    const enrich = (e: ContainsEntry): any => {
      const cs = this.csIndex(e.system, e.version) ?? this.csIndex(e.system);
      const concept = cs && this.lookupConcept(cs, e.code);
      if (!cs || !concept) return { ...e };
      const outEntry: any = { ...e };
      if (opts.includeDesignations && concept.designations.length) {
        outEntry.designation = concept.designations.map((d) => ({
          ...(d.language ? { language: d.language } : {}),
          ...(d.use ? { use: d.use } : {}),
          value: d.value,
        }));
      }
      const wanted = new Set(opts.properties ?? []);
      const statusCode = cs.canonicalProps["status"];
      const propOut: any[] = [];
      for (const rp of concept.rawProps) {
        if (wanted.has(rp.code) || rp.code === statusCode) {
          propOut.push({ ...rp });
          emittedProps.set(rp.code, cs.propUris[rp.code] ?? (rp.code === statusCode ? "http://hl7.org/fhir/concept-properties#status" : ""));
        }
      }
      if (propOut.length) outEntry.property = propOut;
      return outEntry;
    };

    // hierarchy: unless excludeNested=true, nest each entry under its nearest
    // expanded ancestor (CodeSystem concept nesting), preserving pre-order.
    let contains: any[];
    if (opts.excludeNested !== true) {
      const nodes = new Map<string, any>();
      const roots: any[] = [];
      for (const e of entries) {
        const node = enrich(e);
        nodes.set(`${e.system}|${e.code}`, node);
        const cs = this.csIndex(e.system, e.version) ?? this.csIndex(e.system);
        let parentNode: any;
        if (cs) {
          let p = this.lookupConcept(cs, e.code)?.parent;
          while (p !== undefined) {
            parentNode = nodes.get(`${e.system}|${p}`);
            if (parentNode) break;
            p = cs.concepts.get(p)?.parent;
          }
        }
        if (parentNode) (parentNode.contains ??= []).push(node);
        else roots.push(node);
      }
      contains = roots;
    } else {
      contains = entries.map(enrich);
    }

    // contains.version is only emitted when one system appears in >1 version
    // (the battery's mixed-version expansions); single-version expansions stay bare.
    const multiVersion = new Set([...ctx.used.entries()].filter(([, vers]) => vers.size > 1).map(([url]) => url));
    const stripVersion = (list: any[]) => {
      for (const n of list) {
        if (n.version !== undefined && !multiVersion.has(n.system)) delete n.version;
        if (n.contains) stripVersion(n.contains);
      }
    };
    stripVersion(contains);
    const offset = opts.offset ?? 0;
    const paged = contains.slice(offset, opts.count !== undefined ? offset + opts.count : undefined);
    const parameter: any[] = [];
    if (opts.excludeNested !== undefined) parameter.push({ name: "excludeNested", valueBoolean: opts.excludeNested });
    if (opts.activeOnly !== undefined) parameter.push({ name: "activeOnly", valueBoolean: opts.activeOnly });
    if (opts.includeDesignations !== undefined) parameter.push({ name: "includeDesignations", valueBoolean: opts.includeDesignations });
    if (opts.textFilter !== undefined) parameter.push({ name: "filter", valueString: opts.textFilter });
    if (opts.count !== undefined) parameter.push({ name: "count", valueInteger: opts.count });
    if (opts.offset !== undefined && opts.offset !== 0) parameter.push({ name: "offset", valueInteger: opts.offset });
    for (const sys of ctx.applied.force) parameter.push({ name: "force-system-version", valueUri: `${sys}|${ctx.vparams.force.get(sys)}` });
    for (const sys of ctx.applied.check) parameter.push({ name: "check-system-version", valueUri: `${sys}|${ctx.vparams.check.get(sys)}` });
    for (const sys of ctx.applied.deflt) parameter.push({ name: "system-version", valueUri: `${sys}|${ctx.vparams.deflt.get(sys)}` });
    for (const [url, vers] of ctx.used) {
      for (const v of [...vers].sort(compareVersions)) {
        parameter.push({ name: "used-codesystem", valueUri: v ? `${url}|${v}` : url });
      }
    }
    // Echo only the identity of the ValueSet: everything else (id, date,
    // publisher, description, extensions, compose, …) is either optional in the
    // battery fixtures or actively wrong to echo (tx.fhir.org strips them).
    const echo: any = {};
    for (const k of ["resourceType", "url", "version", "name", "title", "status", "experimental"]) {
      if (vs[k] !== undefined) echo[k] = vs[k];
    }
    return {
      valueSet: {
        ...echo,
        expansion: {
          identifier: `urn:uuid:${crypto.randomUUID()}`,
          timestamp: new Date().toISOString(),
          total,
          // offset is echoed only when the client explicitly paged
          ...(opts.offset !== undefined ? { offset } : {}),
          ...(parameter.length ? { parameter } : {}),
          ...(emittedProps.size
            ? { property: [...emittedProps].map(([code, uri]) => ({ code, ...(uri ? { uri } : {}) })) }
            : {}),
          contains: paged,
        },
      },
    };
  }

  /** $validate-code for a coding against an overlay ValueSet (rich, version-aware).
   * Returns null when the overlay cannot decide (→ caller falls back to the store). */
  validateRich(
    vs: any,
    coding: { system?: string; code: string; version?: string; display?: string },
    vparams: VersionParams,
    opts: { lenientDisplay?: boolean } = {},
  ): RichValidation | null {
    /** "S#code ('Display')" — the battery's code reference, echoing a request-supplied display */
    const codeRef = (sys: string) => `${sys}${coding.version ? `|${coding.version}` : ""}#${coding.code}${coding.display ? ` ('${coding.display}')` : ""}`;
    const S = coding.system;
    const vsLabel = vs.version ? `${vs.url}|${vs.version}` : vs.url;
    if (!S) {
      // no system: search the (default-resolved) expansion for the code
      const entries = this.expandCompose(vs);
      if (entries === null) return null;
      const hit = entries.find((e) => e.code === coding.code);
      if (hit) {
        const cs = this.codeSystem(hit.system);
        return { result: true, system: hit.system, version: cs?.version, code: hit.code, display: hit.display ?? (cs && this.lookupConcept(cs, hit.code)?.display), issues: [] };
      }
      return {
        result: false,
        code: coding.code,
        issues: [{ msgId: "None_of_the_provided_codes_are_in_the_value_set_one", issueCode: "code-invalid", txType: "not-in-vs", element: "code", text: `The provided code '#${coding.code}' was not found in the value set '${vsLabel}'` }],
      };
    }
    if (!this.codeSystems.has(S)) {
      // the VS is ours but the coding's system is entirely unknown. Two cases:
      // the VS itself references that system (the VS is broken → the unknown
      // system CAUSED the failure, x-caused-by-unknown-system), or the value
      // is simply foreign to the VS (not-in-vs + x-unknown-system).
      const referenced = [...(vs.compose?.include ?? []), ...(vs.compose?.exclude ?? [])].some((c: any) => c.system === S);
      const unknownIssue: TxIssueSpec =
        coding.version !== undefined
          ? { msgId: "UNKNOWN_CODESYSTEM_VERSION_NONE", issueCode: "not-found", txType: "not-found", element: "system", text: txMessages.unknownVersionNone(S, coding.version) }
          : referenced
            ? { msgId: "UNKNOWN_CODESYSTEM", issueCode: "not-found", txType: "not-found", element: "system", text: txMessages.unknownSystem(S) }
            : { msgId: "UNKNOWN_CODESYSTEM", issueCode: "not-found", txType: "not-found", element: "system", text: `A definition for CodeSystem ${S} could not be found, so the code cannot be validated` };
      if (referenced) {
        return { result: false, code: coding.code, system: S, issues: [unknownIssue], causedByUnknown: S };
      }
      return {
        result: false,
        code: coding.code,
        system: S,
        issues: [
          { msgId: "None_of_the_provided_codes_are_in_the_value_set_one", issueCode: "code-invalid", txType: "not-in-vs", element: "code", text: `The provided code '${codeRef(S)}' was not found in the value set '${vsLabel}'` },
          unknownIssue,
        ],
        unknownSystem: S,
      };
    }
    const versions = this.versionsOf(S);
    const known = versions.filter((v): v is string => v !== undefined);
    const validList = versionList(versions);

    // pick the include clause for this system (mixed VS: first clause whose
    // enumerated concepts contain the code wins; else first clause for S)
    const clauses = (vs.compose?.include ?? []).filter((c: any) => c.system === S);
    if (!clauses.length) {
      // system not in this VS at all → not in VS
      const cs = this.csIndex(S, coding.version && known.includes(coding.version) ? coding.version : undefined);
      const display = cs && this.lookupConcept(cs, coding.code)?.display;
      return {
        result: false,
        code: coding.code,
        system: S,
        version: cs?.version,
        display,
        issues: [{ msgId: "None_of_the_provided_codes_are_in_the_value_set_one", issueCode: "code-invalid", txType: "not-in-vs", element: "code", text: `The provided code '${codeRef(S)}' was not found in the value set '${vsLabel}'` }],
      };
    }
    const clause =
      clauses.find((c: any) => c.concept?.some((k: any) => k.code === coding.code)) ?? clauses[0];

    const res = this.resolveClause(S, clause.version, vparams, coding.version);
    const issues: TxIssueSpec[] = [];
    let causedByUnknown: string | undefined;
    let result = true;
    let finalVersion = res.version;

    let pinUnknown = false;
    if (res.unknownPin !== undefined) {
      // include pins a version we don't have
      pinUnknown = true;
      if (coding.version !== undefined && coding.version !== res.unknownPin) {
        issues.push({ msgId: "VALUESET_VALUE_MISMATCH", issueCode: "invalid", txType: "vs-invalid", element: "version", text: txMessages.versionMismatch(S, res.unknownPin, coding.version) });
      }
      issues.push({ msgId: "UNKNOWN_CODESYSTEM_VERSION", issueCode: "not-found", txType: "not-found", element: "system", text: txMessages.unknownVersion(S, res.unknownPin, validList) });
      causedByUnknown = `${S}|${res.unknownPin}`;
      result = false;
      // the value's own (known) version drives the echo, not the fallback
      if (coding.version !== undefined && known.includes(coding.version)) finalVersion = coding.version;
    } else if (coding.version !== undefined) {
      if (!known.includes(coding.version)) {
        // the value carries a version we don't have
        const steer = res.forced
          ? vparams.force.get(S)
          : res.appliedDefault
            ? vparams.deflt.get(S)
            : res.appliedCheck
              ? vparams.check.get(S)
              : undefined;
        if (steer !== undefined) {
          // a version parameter (force/default/check) chose the version
          issues.push({ msgId: "VALUESET_VALUE_MISMATCH_CHANGED", issueCode: "invalid", txType: "vs-invalid", element: "version", text: txMessages.versionMismatchChanged(S, steer, clause.version ?? "", coding.version) });
          issues.push({ msgId: "UNKNOWN_CODESYSTEM_VERSION", issueCode: "not-found", txType: "not-found", element: "system", text: txMessages.unknownVersion(S, coding.version, validList) });
        } else if (res.pinned !== undefined && res.pinned !== coding.version && !res.pinnedIsWildcard) {
          issues.push({ msgId: "VALUESET_VALUE_MISMATCH", issueCode: "invalid", txType: "vs-invalid", element: "version", text: txMessages.versionMismatch(S, res.pinnedRaw ?? res.pinned, coding.version) });
          issues.push({ msgId: "UNKNOWN_CODESYSTEM_VERSION", issueCode: "not-found", txType: "not-found", element: "system", text: txMessages.unknownVersion(S, coding.version, validList) });
        } else {
          // versionless include: unknown-version error + a warning that the
          // resolved (default) version differs from the value's
          issues.push({ msgId: "UNKNOWN_CODESYSTEM_VERSION", issueCode: "not-found", txType: "not-found", element: "system", text: txMessages.unknownVersion(S, coding.version, validList) });
          if (res.version !== undefined) {
            issues.push({ msgId: "VALUESET_VALUE_MISMATCH_DEFAULT", issueCode: "invalid", txType: "vs-invalid", element: "version", severity: "warning", text: txMessages.versionMismatchDefault(S, res.version, coding.version) });
          }
        }
        causedByUnknown = `${S}|${coding.version}`;
        result = false;
      } else if (res.pinned !== undefined && coding.version !== res.pinned) {
        // known version, but the VS pins a different one
        issues.push({ msgId: "VALUESET_VALUE_MISMATCH", issueCode: "invalid", txType: "vs-invalid", element: "version", text: txMessages.versionMismatch(S, res.pinnedRaw ?? res.pinned, coding.version) });
        result = false;
        if (res.checkViolation) {
          issues.push({ msgId: "VALUESET_VERSION_CHECK", issueCode: "exception", txType: "version-error", element: "version", text: txMessages.checkViolation(res.checkViolation.version, S, res.checkViolation.pattern) });
        }
      } else if (res.pinned === undefined) {
        // no pin: the value's version wins over defaults
        finalVersion = coding.version;
        const K = vparams.check.get(S);
        if (K !== undefined && !versionMatches(K, coding.version)) {
          issues.push({ msgId: "VALUESET_VERSION_CHECK", issueCode: "exception", txType: "version-error", element: "version", text: txMessages.checkViolation(coding.version, S, K) });
          result = false;
        }
      } else {
        finalVersion = coding.version;
        if (res.checkViolation) {
          issues.push({ msgId: "VALUESET_VERSION_CHECK", issueCode: "exception", txType: "version-error", element: "version", text: txMessages.checkViolation(res.checkViolation.version, S, res.checkViolation.pattern) });
          result = false;
        }
      }
    } else if (res.checkViolation) {
      issues.push({ msgId: "VALUESET_VERSION_CHECK", issueCode: "exception", txType: "version-error", element: "version", text: txMessages.checkViolation(res.checkViolation.version, S, res.checkViolation.pattern) });
      result = false;
    }

    const cs = finalVersion !== undefined ? this.csIndex(S, finalVersion) : (res.cs ?? this.csIndex(S));
    if (!cs) return null;
    finalVersion = cs.version;
    const concept = this.lookupConcept(cs, coding.code);
    if (!concept) {
      if (cs.content === "fragment" || cs.content === "example") {
        // a fragment CodeSystem cannot prove a code wrong — warn, don't fail
        issues.push({ msgId: "UNKNOWN_CODE_IN_FRAGMENT", issueCode: "code-invalid", txType: "invalid-code", element: "code", severity: "warning", text: `Unknown Code '${coding.code}' in the CodeSystem '${S}' version '${cs.version ?? ""}' - note that the code system is labeled as a fragment, so the code may be valid in some other fragment` });
        return { result: true, code: coding.code, system: S, version: cs.version, issues, causedByUnknown, pinUnknown };
      }
      issues.push({ msgId: "None_of_the_provided_codes_are_in_the_value_set_one", issueCode: "code-invalid", txType: "not-in-vs", element: "code", text: `The provided code '${codeRef(S)}' was not found in the value set '${vsLabel}'` });
      issues.push({ msgId: "Unknown_Code_in_Version", issueCode: "code-invalid", txType: "invalid-code", element: "code", text: `Unknown code '${coding.code}' in the CodeSystem '${S}' version '${cs.version ?? ""}'` });
      return { result: false, code: coding.code, system: S, version: cs.version, issues, causedByUnknown, pinUnknown };
    }
    // membership check via the plain (parameter-free) expansion — version
    // params steer resolution above but do not change VS membership
    if (result) {
      const ctx: ExpandContext = { vparams: emptyVersionParams(), used: new Map(), applied: { force: new Set(), check: new Set(), deflt: new Set() } };
      const entries = this.expandCompose(vs, new Set(), ctx);
      if (entries !== null) {
        const inVs = entries.some((e) => e.system === S && e.code === coding.code);
        if (!inVs) {
          issues.push({ msgId: "None_of_the_provided_codes_are_in_the_value_set_one", issueCode: "code-invalid", txType: "not-in-vs", element: "code", text: `The provided code '${codeRef(S)}' was not found in the value set '${vsLabel}'` });
          return { result: false, code: coding.code, system: S, version: cs.version, display: concept.display, issues, causedByUnknown, pinUnknown };
        }
      }
    }
    // inactive concepts: flagged always; a VS that excludes inactive codes
    // (compose.inactive=false) rejects them outright with the status trio
    const isInactive = conceptInactive(concept, cs);
    if (result && isInactive && vs.compose?.inactive === false) {
      issues.push({ msgId: "STATUS_CODE_WARNING_CODE", issueCode: "business-rule", txType: "code-rule", element: "code", text: `The concept '${coding.code}' is valid but is not active` });
      issues.push({ msgId: "None_of_the_provided_codes_are_in_the_value_set_one", issueCode: "code-invalid", txType: "not-in-vs", element: "code", text: `The provided code '${codeRef(S)}' was not found in the value set '${vsLabel}'` });
      issues.push({ msgId: "INACTIVE_CONCEPT_FOUND", issueCode: "business-rule", txType: "code-comment", element: "coding", severity: "warning", text: `The concept '${coding.code}' has a status of inactive and its use should be reviewed` });
      result = false;
    }

    // display validation: the supplied display must be the concept display or
    // one of its designations; whitespace-only differences get their own msgId
    if (result && coding.display !== undefined) {
      const validDisplays = [concept.display, ...concept.designations.map((d) => d.value)].filter((d): d is string => !!d);
      if (!validDisplays.includes(coding.display)) {
        const norm = (x: string) => x.replace(/\s+/g, " ").trim();
        const ws = validDisplays.some((d) => norm(d) === norm(coding.display!));
        issues.push({
          msgId: ws ? "Display_Name_WS_for__should_be_one_of__instead_of" : "Display_Name_for__should_be_one_of__instead_of",
          issueCode: "invalid",
          txType: "invalid-display",
          element: "display",
          severity: opts.lenientDisplay ? "warning" : "error",
          text: `Wrong Display Name '${coding.display}' for ${S}#${concept.code}. Valid display is '${concept.display}' (for the language(s) 'en')`,
        });
        if (!opts.lenientDisplay) result = false;
      }
    }
    return { result, code: concept.code, system: S, version: finalVersion, display: concept.display, issues, causedByUnknown, pinUnknown, ...(isInactive ? { inactive: true } : {}) };
  }

  /** Back-compat wrapper used by the CodeSystem-mode route: validate a code
   * directly against a supplied CodeSystem (optionally versioned). */
  validateInCodeSystem(system: string, coding: { code: string; version?: string }): RichValidation | null {
    const versions = this.versionsOf(system);
    if (!this.codeSystems.has(system)) return null;
    const known = versions.filter((v): v is string => v !== undefined);
    if (coding.version !== undefined && !known.includes(coding.version)) {
      return {
        result: false,
        code: coding.code,
        system,
        version: pickLatest(versions),
        issues: [{ msgId: "UNKNOWN_CODESYSTEM_VERSION", issueCode: "not-found", txType: "not-found", element: "system", text: txMessages.unknownVersion(system, coding.version, versionList(versions)) }],
        causedByUnknown: `${system}|${coding.version}`,
      };
    }
    const cs = this.csIndex(system, coding.version);
    if (!cs) return null;
    const concept = this.lookupConcept(cs, coding.code);
    if (!concept) {
      return {
        result: false,
        code: coding.code,
        system,
        version: cs.version,
        issues: [{ issueCode: "code-invalid", txType: "invalid-code", element: "code", text: `Unknown code '${coding.code}' in the CodeSystem '${system}' version '${cs.version ?? ""}'` }],
      };
    }
    return { result: true, code: concept.code, system, version: cs.version, display: concept.display, issues: [] };
  }

  lookupDisplay(system: string, code: string, version?: string): { display?: string; version?: string } | null {
    const cs = this.csIndex(system, version);
    if (!cs) return null;
    const concept = this.lookupConcept(cs, code);
    return concept ? { display: concept.display, version: cs.version } : null;
  }
}

/** The regex-bad battery patterns ((a+)+! etc.) are catastrophic for a
 * backtracking engine but trivially decidable: reduce nested-quantified
 * literal groups to their literal alphabet and match by character-set runs.
 * Returns null when the pattern is not reducible this way. */
function safeNestedQuantifierMatcher(pattern: string): ((code: string) => boolean) | null {
  // strip anchors; we wrap in ^(?:...)$ at the call site anyway
  const p = pattern.replace(/^\^/, "").replace(/\$$/, "");
  // supported shape: literals + grouping + quantifiers only — e.g. (a+)+ or
  // ((a+)+)+. Such a pattern matches exactly the non-empty (with `+`) strings
  // drawn from its literal alphabet, decidable without any backtracking.
  if (!/^[A-Za-z0-9()+*?]+$/.test(p) || !/[()]/.test(p)) return null;
  const letters = new Set(p.replace(/[()+*?]/g, "").split(""));
  if (!letters.size) return null;
  const canBeEmpty = !p.includes("+");
  return (code: string) => (code.length ? [...code].every((ch) => letters.has(ch)) : canBeEmpty);
}

// --- cache-id sessions (in-process; fhirEngine is single-node) ---------------

const MAX_SESSIONS = 32;
const sessions = new Map<string, TxOverlay>();

/** Build the overlay for a request: the cache-id session (if any) accumulates
 * every tx-resource seen for that id, so later calls may omit them. */
export function overlayFor(cacheId: string | undefined, txResources: any[]): TxOverlay {
  if (!cacheId) {
    const overlay = new TxOverlay();
    for (const r of txResources) overlay.register(r);
    return overlay;
  }
  let overlay = sessions.get(cacheId);
  if (!overlay) {
    overlay = new TxOverlay();
    sessions.set(cacheId, overlay);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
  }
  for (const r of txResources) overlay.register(r);
  return overlay;
}
