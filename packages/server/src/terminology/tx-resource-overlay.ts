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
 */

interface Designation { language?: string; value: string }

export interface OverlayConcept {
  code: string;
  display?: string;
  definition?: string;
  parent?: string;
  children: string[];
  designations: Designation[];
  /** property code -> values (from CodeSystem.concept.property value[x]) */
  properties: Record<string, unknown[]>;
}

interface CodeSystemIndex {
  url: string;
  version?: string;
  caseSensitive: boolean;
  content?: string;
  resource: any;
  concepts: Map<string, OverlayConcept>; // keyed by code (exact case)
  byLowerCode: Map<string, string>; // lower(code) -> code, for caseSensitive=false
}

export interface ExpandOptions {
  count?: number;
  offset?: number;
  textFilter?: string;
  activeOnly?: boolean;
  excludeNested?: boolean;
}

export interface ContainsEntry {
  system: string;
  code: string;
  display?: string;
  abstract?: boolean;
  inactive?: boolean;
}

export type OverlayValidation =
  | { status: "valid"; system: string; version?: string; code: string; display?: string }
  | { status: "not-in-vs"; system?: string; code: string; message: string }
  | { status: "invalid-code"; system: string; version?: string; code: string; message: string }
  | { status: "unknown-system"; system?: string; code: string; message: string };

function indexConcepts(cs: any): CodeSystemIndex {
  const idx: CodeSystemIndex = {
    url: cs.url,
    version: cs.version,
    caseSensitive: cs.caseSensitive !== false,
    content: cs.content,
    resource: cs,
    concepts: new Map(),
    byLowerCode: new Map(),
  };
  const walk = (concepts: any[], parent?: string) => {
    for (const c of concepts ?? []) {
      const entry: OverlayConcept = {
        code: c.code,
        display: c.display,
        definition: c.definition,
        parent,
        children: (c.concept ?? []).map((k: any) => k.code),
        designations: (c.designation ?? []).map((d: any) => ({ language: d.language, value: d.value })),
        properties: {},
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

function conceptInactive(concept: OverlayConcept): boolean {
  const status = concept.properties["status"]?.[0];
  return (
    concept.properties["inactive"]?.[0] === true ||
    status === "retired" ||
    status === "deprecated" ||
    concept.properties["deprecated"]?.[0] === true
  );
}

function conceptAbstract(concept: OverlayConcept): boolean {
  return concept.properties["notSelectable"]?.[0] === true;
}

export class TxOverlay {
  private codeSystems = new Map<string, CodeSystemIndex[]>(); // url -> versions
  private valueSets = new Map<string, any[]>(); // url -> versions

  register(resource: any): void {
    if (!resource?.url) return;
    if (resource.resourceType === "CodeSystem") {
      const list = this.codeSystems.get(resource.url) ?? [];
      if (!list.some((x) => x.version === resource.version)) list.push(indexConcepts(resource));
      this.codeSystems.set(resource.url, list);
    } else if (resource.resourceType === "ValueSet") {
      const list = this.valueSets.get(resource.url) ?? [];
      if (!list.some((x) => x.version === resource.version)) list.push(resource);
      this.valueSets.set(resource.url, list);
    }
  }

  get empty(): boolean {
    return this.codeSystems.size === 0 && this.valueSets.size === 0;
  }

  /** Split a canonical `url|version` and find the resource; no version → latest supplied. */
  codeSystem(canonical: string | undefined): CodeSystemIndex | undefined {
    if (!canonical) return undefined;
    const [url, version] = canonical.split("|");
    const list = this.codeSystems.get(url);
    if (!list?.length) return undefined;
    return version ? list.find((x) => x.version === version) : list[list.length - 1];
  }

  valueSet(canonical: string | undefined): any | undefined {
    if (!canonical) return undefined;
    const [url, version] = canonical.split("|");
    const list = this.valueSets.get(url);
    if (!list?.length) return undefined;
    return version ? list.find((x) => x.version === version) : list[list.length - 1];
  }

  private lookupConcept(cs: CodeSystemIndex, code: string): OverlayConcept | undefined {
    const direct = cs.concepts.get(code);
    if (direct || cs.caseSensitive) return direct;
    const canonical = cs.byLowerCode.get(code.toLowerCase());
    return canonical !== undefined ? cs.concepts.get(canonical) : undefined;
  }

  /** All codes matching one compose include/exclude clause, in definition order.
   * `visiting` is the in-progress ValueSet recursion stack (circular-import guard). */
  private clauseCodes(clause: any, visiting: Set<string>): ContainsEntry[] | null {
    // include.valueSet: union across the referenced VS (intersected with the
    // system clause when both are present, per the spec).
    let imported: Set<string> | null = null;
    if (clause.valueSet?.length) {
      imported = new Set<string>();
      for (const vsRef of clause.valueSet) {
        const inner = this.valueSet(vsRef);
        if (!inner) return null; // unknown import → cannot expand this clause
        const entries = this.expandCompose(inner, visiting);
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
    const cs = this.codeSystem(clause.version ? `${clause.system}|${clause.version}` : clause.system);
    if (!cs) return null; // system not in overlay → caller falls back / errors
    let entries: ContainsEntry[];
    if (clause.concept?.length) {
      entries = clause.concept.map((c: any) => {
        const known = this.lookupConcept(cs, c.code);
        const display = c.display ?? known?.display;
        return { system: cs.url, code: c.code, ...(display ? { display } : {}) };
      });
    } else {
      entries = [...cs.concepts.values()].map((concept) => ({
        system: cs.url,
        code: concept.code,
        ...(concept.display ? { display: concept.display } : {}),
        ...(conceptAbstract(concept) ? { abstract: true } : {}),
        ...(conceptInactive(concept) ? { inactive: true } : {}),
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
        // loop for good). Star-height>1 and oversized patterns are refused as
        // too costly (→ clause unexpandable → OperationOutcome), matching the
        // battery's expected "took too long to evaluate" behavior.
        if (f.value.length > 256 || /\([^()]*[+*{][^()]*\)\s*[+*?{]/.test(f.value)) return null;
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
  private expandCompose(vs: any, visiting: Set<string> = new Set()): ContainsEntry[] | null {
    const stackKey = vs.version ? `${vs.url}|${vs.version}` : String(vs.url);
    if (visiting.has(stackKey)) return null; // circular import → cannot expand
    visiting.add(stackKey);
    try {
      const out: ContainsEntry[] = [];
      const seen = new Set<string>();
      for (const inc of vs.compose?.include ?? []) {
        const entries = this.clauseCodes(inc, visiting);
        if (entries === null) return null;
        for (const e of entries) {
          const key = `${e.system}|${e.code}`;
          if (!seen.has(key)) { seen.add(key); out.push(e); }
        }
      }
      for (const exc of vs.compose?.exclude ?? []) {
        const entries = this.clauseCodes(exc, visiting);
        if (entries === null) return null;
        for (const e of entries) {
          const key = `${e.system}|${e.code}`;
          const at = out.findIndex((x) => `${x.system}|${x.code}` === key);
          if (at >= 0) { out.splice(at, 1); seen.delete(key); }
        }
      }
      return out;
    } finally {
      visiting.delete(stackKey);
    }
  }

  /** $expand over an overlay ValueSet. Returns the ValueSet echo + expansion, or an error. */
  expand(vs: any, opts: ExpandOptions): { valueSet?: any; error?: string } {
    let entries = this.expandCompose(vs);
    if (entries === null) return { error: `ValueSet ${vs.url} cannot be expanded from supplied resources` };
    if (opts.activeOnly) entries = entries.filter((e) => !e.inactive);
    if (opts.textFilter) {
      const t = opts.textFilter.toLowerCase();
      entries = entries.filter((e) => e.code.toLowerCase().includes(t) || e.display?.toLowerCase().includes(t));
    }
    const total = entries.length;
    const offset = opts.offset ?? 0;
    const paged = entries.slice(offset, opts.count !== undefined ? offset + opts.count : undefined);
    const usedSystems = [...new Set(entries.map((e) => e.system))].map((u) => {
      const cs = this.codeSystem(u);
      return cs?.version ? `${u}|${cs.version}` : u;
    });
    const parameter: any[] = [];
    if (opts.excludeNested !== undefined) parameter.push({ name: "excludeNested", valueBoolean: opts.excludeNested });
    if (opts.activeOnly !== undefined) parameter.push({ name: "activeOnly", valueBoolean: opts.activeOnly });
    if (opts.count !== undefined) parameter.push({ name: "count", valueInteger: opts.count });
    if (opts.offset !== undefined && opts.offset !== 0) parameter.push({ name: "offset", valueInteger: opts.offset });
    for (const u of usedSystems) parameter.push({ name: "used-codesystem", valueUri: u });
    const { expansion: _prior, ...echo } = vs;
    return {
      valueSet: {
        ...echo,
        expansion: {
          identifier: `urn:uuid:${crypto.randomUUID()}`,
          timestamp: new Date().toISOString(),
          total,
          offset,
          ...(parameter.length ? { parameter } : {}),
          contains: paged,
        },
      },
    };
  }

  /** $validate-code for a coding, optionally against an overlay ValueSet. */
  validate(vsCanonical: string | undefined, coding: { system?: string; code: string; version?: string }): OverlayValidation | null {
    const vs = vsCanonical ? this.valueSet(vsCanonical) : undefined;
    if (vsCanonical && !vs) return null; // VS not in overlay → caller falls back
    if (vs) {
      const entries = this.expandCompose(vs);
      if (entries === null) return null;
      const hit = entries.find((e) => e.code === coding.code && (!coding.system || e.system === coding.system));
      if (hit) {
        const cs = this.codeSystem(hit.system);
        return { status: "valid", system: hit.system, version: cs?.version, code: hit.code, display: hit.display ?? this.lookupConcept(cs!, hit.code)?.display };
      }
      // Not in the VS — distinguish bad-code-in-system from merely not-in-vs.
      const cs = this.codeSystem(coding.system);
      const vsLabel = vs.version ? `${vs.url}|${vs.version}` : vs.url;
      if (cs && !this.lookupConcept(cs, coding.code)) {
        return { status: "invalid-code", system: cs.url, version: cs.version, code: coding.code, message: `Unknown code '${coding.code}' in the CodeSystem '${cs.url}'; also not in the value set '${vsLabel}'` };
      }
      return { status: "not-in-vs", system: coding.system, code: coding.code, message: `The provided code '${coding.system}#${coding.code}' was not found in the value set '${vsLabel}'` };
    }
    const cs = this.codeSystem(coding.version ? `${coding.system}|${coding.version}` : coding.system);
    if (!cs) return null;
    const concept = this.lookupConcept(cs, coding.code);
    if (!concept) return { status: "invalid-code", system: cs.url, version: cs.version, code: coding.code, message: `Unknown code '${coding.code}' in the CodeSystem '${cs.url}' version '${cs.version ?? ""}'` };
    return { status: "valid", system: cs.url, version: cs.version, code: concept.code, display: concept.display };
  }

  lookupDisplay(system: string, code: string): { display?: string; version?: string } | null {
    const cs = this.codeSystem(system);
    if (!cs) return null;
    const concept = this.lookupConcept(cs, code);
    return concept ? { display: concept.display, version: cs.version } : null;
  }
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
