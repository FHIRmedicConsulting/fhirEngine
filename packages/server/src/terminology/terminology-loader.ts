/**
 * Terminology loader (provisioning). Extracts CodeSystem concepts + ValueSet
 * expansions from FHIR conformance resources (e.g. from an IG package) and writes
 * them to the terminology Delta tables via delta-rs. Pure-local; no external tx server.
 *
 * First cut handles the common compose cases: include with explicit `concept` lists,
 * and include-whole-system (expanded from a loaded CodeSystem). Intensional /
 * filter / external-system expansions are deferred (see terminology design doc).
 */
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";

interface ConceptRow { system: string; code: string; display: string | null; version: string | null }
interface ExpansionRow { valueset: string; version: string | null; system: string; code: string; display: string | null }

/** Recursively extract concepts from a CodeSystem (including nested concept trees). */
export function extractConcepts(cs: any): ConceptRow[] {
  const system: string = cs.url;
  const version: string | null = cs.version ?? null;
  const out: ConceptRow[] = [];
  const walk = (concepts: any[] | undefined) => {
    for (const c of concepts ?? []) {
      out.push({ system, code: c.code, display: c.display ?? null, version });
      if (c.concept) walk(c.concept);
    }
  };
  walk(cs.concept);
  return out;
}

/** Expand a ValueSet (simple compose cases) given concepts already loaded by system.
 * `complete: false` = some compose part could not be expanded locally (filter/intensional
 * include, valueSet import, unloaded external system, or any exclude) — the stored expansion
 * is PARTIAL, so a membership miss must degrade to `unknown`, never `invalid`. */
export function expandValueSet(
  vs: any,
  conceptsBySystem: Map<string, ConceptRow[]>,
): { rows: ExpansionRow[]; complete: boolean } {
  const valueset: string = vs.url;
  const version: string | null = vs.version ?? null;
  const out: ExpansionRow[] = [];
  let complete = !(Array.isArray(vs.compose?.exclude) && vs.compose.exclude.length); // excludes are not applied
  for (const inc of vs.compose?.include ?? []) {
    const system: string | undefined = inc.system;
    if (Array.isArray(inc.filter) && inc.filter.length) {
      complete = false; // intensional include — do NOT dump the whole system (the filter restricts it)
    } else if (Array.isArray(inc.concept) && inc.concept.length) {
      for (const c of inc.concept) out.push({ valueset, version, system: system ?? "", code: c.code, display: c.display ?? null });
    } else if (Array.isArray(inc.valueSet) && inc.valueSet.length) {
      complete = false; // value-set import — deferred
    } else if (system && conceptsBySystem.has(system)) {
      for (const c of conceptsBySystem.get(system)!) out.push({ valueset, version, system, code: c.code, display: c.display });
    } else {
      complete = false; // whole external system not loaded — deferred
    }
  }
  return { rows: out, complete };
}

export interface TerminologyLoadResult {
  codeSystems: number;
  concepts: number;
  valueSets: number;
  expansions: number;
}

/** Load CodeSystem/ValueSet resources into the terminology tables. */
export async function loadTerminologyResources(
  wh: DeltaWarehouse,
  resources: any[],
  mode: "append" | "overwrite" = "append",
): Promise<TerminologyLoadResult> {
  const codeSystems = resources.filter((r) => r?.resourceType === "CodeSystem");
  const valueSets = resources.filter((r) => r?.resourceType === "ValueSet");

  const concepts = codeSystems.flatMap(extractConcepts);
  const conceptsBySystem = new Map<string, ConceptRow[]>();
  for (const c of concepts) {
    if (!conceptsBySystem.has(c.system)) conceptsBySystem.set(c.system, []);
    conceptsBySystem.get(c.system)!.push(c);
  }
  const expanded = valueSets.filter((vs) => vs.url).map((vs) => ({ vs, ...expandValueSet(vs, conceptsBySystem) }));
  const expansions = expanded.flatMap((e) => e.rows);

  if (concepts.length) await wh.writeTerminology("codesystem_concept", concepts, mode);
  if (expansions.length) await wh.writeTerminology("valueset_expansion", expansions, mode);

  // One valueset_header row per ValueSet: records whether the stored expansion is COMPLETE.
  // validate-code treats a miss against a partial expansion as `unknown` (resolvable), not
  // `invalid` — partial sets otherwise hard-reject valid codes (e.g. LOINC doc types).
  const vsHeaders = expanded.map((e) => ({
    url: e.vs.url as string,
    version: (e.vs.version ?? null) as string | null,
    complete: e.complete,
  }));
  if (vsHeaders.length) await wh.writeTerminology("valueset_header", vsHeaders, mode);

  // One codesystem_header row per loaded CodeSystem (so check-updates / version pins see them).
  const headerRows = codeSystems
    .filter((cs) => cs.url)
    .map((cs) => ({
      url: cs.url as string,
      version: (cs.version ?? null) as string | null,
      count: conceptsBySystem.get(cs.url)?.length ?? 0,
      content: (cs.content ?? "complete") as string,
    }));
  if (headerRows.length) await wh.writeTerminology("codesystem_header", headerRows, mode);

  return { codeSystems: codeSystems.length, concepts: concepts.length, valueSets: valueSets.length, expansions: expansions.length };
}
