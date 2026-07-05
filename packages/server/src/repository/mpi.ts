/**
 * Deterministic MPI / dedup — ADR-0012 v1, enforced at PROMOTION (Bronze → Silver/Gold).
 *
 * Identity resolution over the current Bronze Patient set (full-rebuild, matching the
 * reference promoter's semantics): patients sharing a normalized business identifier are
 * candidate duplicates. Hard-deny guardrails (ADR-0012 §3.4 — safety floors, NOT
 * configurable off) gate every auto-merge; anything ambiguous lands in the
 * `patient_match_review` queue instead of merging. Survivor = latest write wins
 * (ADR-0008 §D8 narrow v1).
 *
 * Probabilistic matching (Splink) and PPRL are v2/v1.x per the ADR and belong to the
 * external promotion pipeline (Dagster/Databricks) in the fhirEngine topology — this
 * module is the deterministic stage both share.
 */

export interface MpiPatientRow {
  id: string;
  last_updated: string;
  body: Record<string, unknown>; // parsed Patient body_json
}

export interface MpiMerge {
  survivorId: string;
  mergedId: string;
  rule: string; // decision_path, e.g. deterministic_rule:shared-identifier
  sharedIdentifiers: string[]; // normalized system|value keys that linked the pair
}

export interface MpiReview {
  ids: string[]; // the candidate set that could not be auto-merged
  reason: string; // guardrail / ambiguity that blocked the merge
  sharedIdentifiers: string[];
  evidence: Array<{ id: string; name?: string; birthDate?: string; gender?: string; identifiers: string[] }>;
}

export interface MpiResolution {
  merges: MpiMerge[];
  reviews: MpiReview[];
  /** merged id → surviving id (transitively resolved). */
  survivorOf: Map<string, string>;
  /** normalized identifier key → surviving fhir id (the patient_link content). */
  links: Map<string, string>;
}

const SSN_SYSTEM = "http://hl7.org/fhir/sid/us-ssn";

/** Identifier normalization (ADR-0012 §3): canonical system URI + trimmed value. */
export function normalizeIdentifier(system: unknown, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let sys = typeof system === "string" ? system.trim() : "";
  try {
    const u = new URL(sys);
    u.protocol = u.protocol.toLowerCase();
    u.host = u.host.toLowerCase();
    sys = u.toString().replace(/\/$/, "");
  } catch {
    sys = sys.replace(/\/$/, ""); // urn:oid:… and friends — trim only
  }
  let val = value.trim().replace(/\s+/g, " ");
  if (sys === SSN_SYSTEM) val = val.replace(/\D/g, ""); // SSN format collapsed
  return `${sys}|${val}`;
}

function identifierKeys(body: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const ident of (body.identifier as Array<Record<string, unknown>> | undefined) ?? []) {
    const k = normalizeIdentifier(ident?.system, ident?.value);
    if (k) out.add(k);
  }
  return [...out];
}

function ssnOf(body: Record<string, unknown>): string | null {
  for (const ident of (body.identifier as Array<Record<string, unknown>> | undefined) ?? []) {
    const k = normalizeIdentifier(ident?.system, ident?.value);
    if (k?.startsWith(`${SSN_SYSTEM}|`)) return k;
  }
  return null;
}

/** Hard-deny guardrails (ADR-0012 §3.4) for a candidate pair. Returns the blocking
 * reason, "distinct" for the hard-distinct SSN rule, or null (pair may auto-merge). */
export function guardrail(a: MpiPatientRow, b: MpiPatientRow, deceasedWindowDays = 14): string | null {
  const [sa, sb] = [ssnOf(a.body), ssnOf(b.body)];
  if (sa && sb && sa !== sb) return "distinct"; // conflicting authoritative identifier → never match
  const [ga, gb] = [a.body.gender, b.body.gender];
  if (ga && gb && ga !== gb && ga !== "unknown" && gb !== "unknown") return "sex_mismatch";
  const [da, db] = [a.body.deceasedDateTime, b.body.deceasedDateTime];
  if (typeof da === "string" && typeof db === "string") {
    const ms = Math.abs(new Date(da).getTime() - new Date(db).getTime());
    if (ms > deceasedWindowDays * 86_400_000) return "date_of_death_mismatch";
  }
  if (a.body.active === false || b.body.active === false) return "inactive_candidate";
  return null;
}

function evidence(rows: MpiPatientRow[]): MpiReview["evidence"] {
  return rows.map((r) => {
    const name0 = ((r.body.name as Array<Record<string, unknown>> | undefined) ?? [])[0];
    const rendered = name0 ? [...((name0.given as string[] | undefined) ?? []), name0.family].filter(Boolean).join(" ") : undefined;
    return {
      id: r.id,
      name: rendered,
      birthDate: r.body.birthDate as string | undefined,
      gender: r.body.gender as string | undefined,
      identifiers: identifierKeys(r.body),
    };
  });
}

/**
 * Resolve identities across the current Patient set.
 * - Pairs sharing ≥1 normalized identifier are candidate duplicates.
 * - Hard-distinct (SSN conflict) severs the candidate edge entirely.
 * - A candidate component of exactly 2 that passes all guardrails → auto-merge
 *   (survivor = latest last_updated). Guardrail-blocked pair → review.
 * - A component of >2 = the ADR's multi-match → review (never auto-merged).
 */
export function resolveIdentities(rows: MpiPatientRow[], opts?: { deceasedWindowDays?: number }): MpiResolution {
  const window = opts?.deceasedWindowDays ?? 14;
  const byKey = new Map<string, MpiPatientRow[]>();
  const rowById = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    if (r.body.active === false) continue; // merged-away records are not candidates
    for (const k of identifierKeys(r.body)) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(r);
    }
  }

  // Union-find over identifier-sharing pairs (minus hard-distinct edges).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) { p = find(p); parent.set(x, p); }
    return p;
  };
  const union = (x: string, y: string) => { const [px, py] = [find(x), find(y)]; if (px !== py) parent.set(px, py); };
  const sharedKeys = new Map<string, Set<string>>(); // "a~b" (sorted) → keys they share
  for (const [key, members] of byKey) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [a, b] = [members[i], members[j]];
        if (guardrail(a, b, window) === "distinct") continue; // SSN conflict: never link
        union(a.id, b.id);
        const pk = [a.id, b.id].sort().join("~");
        if (!sharedKeys.has(pk)) sharedKeys.set(pk, new Set());
        sharedKeys.get(pk)!.add(key);
      }
    }
  }

  const components = new Map<string, string[]>();
  for (const r of rows) {
    if (r.body.active === false) continue;
    const root = find(r.id);
    if (!components.has(root)) components.set(root, []);
    components.get(root)!.push(r.id);
  }

  const res: MpiResolution = { merges: [], reviews: [], survivorOf: new Map(), links: new Map() };
  for (const ids of components.values()) {
    const members = ids.map((id) => rowById.get(id)!);
    if (ids.length === 1) {
      for (const k of identifierKeys(members[0].body)) res.links.set(k, members[0].id);
      continue;
    }
    const shared = [...new Set(ids.flatMap((_, i) => ids.flatMap((__, j) => i < j ? [...(sharedKeys.get([ids[i], ids[j]].sort().join("~")) ?? [])] : [])))];
    if (ids.length > 2) {
      // Multi-match (≥2 distinct candidates for one identity) → stewardship, never auto (ADR §1).
      res.reviews.push({ ids, reason: "multi_match", sharedIdentifiers: shared, evidence: evidence(members) });
      for (const m of members) for (const k of identifierKeys(m.body)) if (!res.links.has(k)) res.links.set(k, m.id);
      continue;
    }
    const [a, b] = members;
    const block = guardrail(a, b, window);
    if (block) {
      res.reviews.push({ ids, reason: block, sharedIdentifiers: shared, evidence: evidence(members) });
      for (const m of members) for (const k of identifierKeys(m.body)) if (!res.links.has(k)) res.links.set(k, m.id);
      continue;
    }
    const survivor = a.last_updated >= b.last_updated ? a : b; // latest write wins (ADR-0008 §D8)
    const merged = survivor === a ? b : a;
    res.merges.push({ survivorId: survivor.id, mergedId: merged.id, rule: "deterministic_rule:shared-identifier", sharedIdentifiers: shared });
    res.survivorOf.set(merged.id, survivor.id);
    for (const m of members) for (const k of identifierKeys(m.body)) res.links.set(k, survivor.id);
  }
  return res;
}

/** Rewrite a single FHIR reference string `Patient/<merged>[/_history/…]` (or an absolute
 * URL ending in that) to the survivor. Exact id-token match only — a naive substring replace
 * would corrupt an UNRELATED `Patient/1234` when merging `Patient/123`. */
function rewriteRefString(ref: string, survivorOf: Map<string, string>): string {
  const i = ref.lastIndexOf("Patient/");
  if (i < 0) return ref;
  const after = ref.slice(i + "Patient/".length); // "<id>" | "<id>/_history/2"
  const slash = after.indexOf("/");
  const id = slash < 0 ? after : after.slice(0, slash);
  const survivor = survivorOf.get(id);
  return survivor ? `${ref.slice(0, i)}Patient/${survivor}${slash < 0 ? "" : after.slice(slash)}` : ref;
}

/** Rewrite merged→survivor Patient references throughout a serialized resource body — walks
 * the parsed structure and only touches actual `reference` fields (FHIR-correct: does not
 * mutate free-text mentions, and is immune to id-substring collisions). */
export function rewriteReferences(bodyJson: string, survivorOf: Map<string, string>): string {
  if (!survivorOf.size) return bodyJson;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (k === "reference" && typeof o[k] === "string") o[k] = rewriteRefString(o[k] as string, survivorOf);
        else o[k] = walk(o[k]);
      }
      return o;
    }
    return node;
  };
  return JSON.stringify(walk(JSON.parse(bodyJson)));
}
