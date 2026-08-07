/**
 * Probabilistic MPI scoring (ADR-0012 v2) — a Fellegi-Sunter record-linkage layer over the
 * deterministic engine (mpi.ts). Where the deterministic stage links patients that SHARE a
 * normalized business identifier, this scores demographic similarity for pairs that do NOT —
 * the "same person, different/absent MRN" case deterministic matching can't catch.
 *
 * Method (classic Fellegi-Sunter, curated weights — no training set needed, the standard
 * approach for a rules-configured MPI a la Splink's default m/u): each comparison field
 * contributes a log2 match weight — `+log2(m/u)` on agreement, `-log2((1-u)/(1-m))` on
 * disagreement, and a partial weight for a near string match (Jaro-Winkler in a band). The
 * summed weight classifies the pair; a logistic of the weight is the 0..1 score.
 *
 * Probabilistic candidates are NEVER auto-merged (safety — ADR-0012 §3.4): they surface via
 * `Patient/$match` and, when enabled at promotion, feed the stewardship review queue.
 */

export type MatchGrade = "certain" | "probable" | "possible" | "certainly-not";

export interface Comparison { name: string; value: number; state: "agree" | "near" | "disagree" | "missing" }
export interface PairScore {
  weight: number;        // summed log2 match weight
  probability: number;   // logistic(weight), 0..1
  grade: MatchGrade;
  comparisons: Comparison[];
}

/** Curated m (P agree|match) / u (P agree|non-match) per field; `near` scales the agree weight. */
interface FieldWeight { m: number; u: number; nearFactor: number }
const WEIGHTS: Record<string, FieldWeight> = {
  family:     { m: 0.90, u: 0.010, nearFactor: 0.6 },
  given:      { m: 0.88, u: 0.030, nearFactor: 0.6 },
  birthDate:  { m: 0.95, u: 0.003, nearFactor: 0.5 }, // near = same year+month
  gender:     { m: 0.98, u: 0.500, nearFactor: 0 },   // weak (binary-ish)
  postalCode: { m: 0.85, u: 0.050, nearFactor: 0 },
  phone:      { m: 0.75, u: 0.001, nearFactor: 0 },   // strong when present
};

const agreeWeight = (f: FieldWeight): number => Math.log2(f.m / f.u);
const disagreeWeight = (f: FieldWeight): number => Math.log2((1 - f.m) / (1 - f.u)); // negative

/** Grade thresholds on the summed weight (overridable via env for deployment tuning). */
function thresholds(): { certain: number; probable: number; possible: number } {
  const n = (k: string, d: number): number => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] ? v : d; };
  return {
    certain: n("FHIRENGINE_MPI_THRESHOLD_CERTAIN", 12),
    probable: n("FHIRENGINE_MPI_THRESHOLD_PROBABLE", 6),
    possible: n("FHIRENGINE_MPI_THRESHOLD_POSSIBLE", 2),
  };
}

function gradeFor(weight: number): MatchGrade {
  const t = thresholds();
  if (weight >= t.certain) return "certain";
  if (weight >= t.probable) return "probable";
  if (weight >= t.possible) return "possible";
  return "certainly-not";
}

// ── string similarity: Jaro-Winkler ───────────────────────────────────────────
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1m = new Array<boolean>(s1.length).fill(false);
  const s2m = new Array<boolean>(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchWindow), hi = Math.min(i + matchWindow + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (!s2m[j] && s1[i] === s2[j]) { s1m[i] = true; s2m[j] = true; matches++; break; }
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1m[i]) continue;
    while (!s2m[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  t /= 2;
  const jaro = (matches / s1.length + matches / s2.length + (matches - t) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) { if (s1[i] === s2[i]) prefix++; else break; }
  return jaro + prefix * 0.1 * (1 - jaro);
}

const norm = (s: unknown): string => (typeof s === "string" ? s.trim().toLowerCase() : "");

// ── demographic extraction ────────────────────────────────────────────────────
export interface Demographics {
  family: string; given: string; birthDate: string; gender: string; postalCode: string; phones: string[];
}
export function extractDemographics(patient: Record<string, unknown>): Demographics {
  const name0 = ((patient.name as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};
  const address0 = ((patient.address as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};
  const phones = ((patient.telecom as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((t) => t?.system === "phone" && typeof t?.value === "string")
    .map((t) => String(t.value).replace(/\D/g, ""))
    .filter(Boolean);
  return {
    family: norm(name0.family),
    given: norm(((name0.given as string[] | undefined) ?? [])[0]),
    birthDate: norm(patient.birthDate),
    gender: norm(patient.gender),
    postalCode: norm(address0.postalCode).replace(/\s/g, ""),
    phones,
  };
}

function stringComparison(name: string, a: string, b: string, nearThreshold = 0.9): Comparison {
  const f = WEIGHTS[name]!;
  if (!a || !b) return { name, value: 0, state: "missing" };
  if (a === b) return { name, value: agreeWeight(f), state: "agree" };
  const jw = jaroWinkler(a, b);
  if (f.nearFactor > 0 && jw >= nearThreshold) return { name, value: agreeWeight(f) * f.nearFactor, state: "near" };
  return { name, value: disagreeWeight(f), state: "disagree" };
}

function birthDateComparison(a: string, b: string): Comparison {
  const f = WEIGHTS.birthDate!;
  if (!a || !b) return { name: "birthDate", value: 0, state: "missing" };
  if (a === b) return { name: "birthDate", value: agreeWeight(f), state: "agree" };
  if (a.slice(0, 7) === b.slice(0, 7)) return { name: "birthDate", value: agreeWeight(f) * f.nearFactor, state: "near" }; // same year-month
  return { name: "birthDate", value: disagreeWeight(f), state: "disagree" };
}

function exactComparison(name: string, a: string, b: string): Comparison {
  const f = WEIGHTS[name]!;
  if (!a || !b) return { name, value: 0, state: "missing" };
  if (a === b) return { name, value: agreeWeight(f), state: "agree" };
  return { name, value: disagreeWeight(f), state: "disagree" };
}

function phoneComparison(a: string[], b: string[]): Comparison {
  const f = WEIGHTS.phone!;
  if (!a.length || !b.length) return { name: "phone", value: 0, state: "missing" };
  if (a.some((x) => b.includes(x))) return { name: "phone", value: agreeWeight(f), state: "agree" };
  return { name: "phone", value: disagreeWeight(f), state: "disagree" };
}

/** Score a candidate pair. Deterministic + order-independent. */
export function scorePair(a: Record<string, unknown>, b: Record<string, unknown>): PairScore {
  const da = extractDemographics(a), db = extractDemographics(b);
  const comparisons: Comparison[] = [
    stringComparison("family", da.family, db.family),
    stringComparison("given", da.given, db.given),
    birthDateComparison(da.birthDate, db.birthDate),
    exactComparison("gender", da.gender, db.gender),
    exactComparison("postalCode", da.postalCode, db.postalCode),
    phoneComparison(da.phones, db.phones),
  ];
  const weight = comparisons.reduce((s, c) => s + c.value, 0);
  const probability = 1 / (1 + Math.pow(2, -weight));
  return { weight, probability, grade: gradeFor(weight), comparisons };
}

export interface ProbabilisticPair { ids: [string, string]; grade: MatchGrade; probability: number; weight: number }

/**
 * Find probabilistic duplicate CANDIDATES across a Patient set that do NOT already share a
 * business identifier (those are the deterministic engine's job). Uses blocking so it's
 * near-linear, not O(n²). Returns `probable`/`certain`-graded pairs for the stewardship queue —
 * probabilistic matches are NEVER auto-merged (ADR-0012 §3.4 safety floor).
 *
 * `sharedIdentifierPairs` = the "a~b" (sorted) keys the deterministic stage already linked, so
 * we don't re-surface a pair it will merge.
 */
export function probabilisticCandidates(
  rows: Array<{ id: string; body: Record<string, unknown> }>,
  sharedIdentifierPairs: Set<string>,
): ProbabilisticPair[] {
  const blocks = new Map<string, string[]>(); // blocking key → row ids
  const byId = new Map(rows.map((r) => [r.id, r.body]));
  for (const r of rows) {
    if (r.body.active === false) continue;
    for (const k of blockingKeys(r.body)) {
      if (!blocks.has(k)) blocks.set(k, []);
      blocks.get(k)!.push(r.id);
    }
  }
  const scoredPairs = new Map<string, ProbabilisticPair>();
  for (const ids of blocks.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pk = [ids[i]!, ids[j]!].sort().join("~");
        if (scoredPairs.has(pk) || sharedIdentifierPairs.has(pk)) continue; // dedup + skip deterministic
        const s = scorePair(byId.get(ids[i]!)!, byId.get(ids[j]!)!);
        if (s.grade === "probable" || s.grade === "certain") {
          scoredPairs.set(pk, { ids: pk.split("~") as [string, string], grade: s.grade, probability: s.probability, weight: s.weight });
        }
      }
    }
  }
  return [...scoredPairs.values()].sort((a, b) => b.weight - a.weight);
}

/** Blocking keys for candidate generation (avoids O(n²) — a pair must share ≥1 block to be
 * scored). Standard MPI blocks: family+birth-year, soundex-ish name prefix, phone, postal+dob. */
export function blockingKeys(patient: Record<string, unknown>): string[] {
  const d = extractDemographics(patient);
  const keys: string[] = [];
  if (d.family && d.birthDate) keys.push(`fam-yob:${d.family}:${d.birthDate.slice(0, 4)}`);
  if (d.family && d.given) keys.push(`fam-gin:${d.family}:${d.given[0] ?? ""}`);
  if (d.birthDate && d.postalCode) keys.push(`dob-zip:${d.birthDate}:${d.postalCode}`);
  for (const p of d.phones) keys.push(`phone:${p}`);
  return keys;
}
