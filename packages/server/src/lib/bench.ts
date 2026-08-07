/**
 * Scale-benchmark helpers (pure + testable) for `fhirengine-bench`.
 *
 * Latency-distribution stats, a deterministic synthetic FHIR population generator (so a run is
 * reproducible from a seed), and report formatting. The runner (scripts/fhirengine-bench.ts)
 * drives the in-process app with these and emits a JSON + human summary.
 */

// ── latency stats ──────────────────────────────────────────────────────────────
export interface LatencyStats {
  count: number; min: number; mean: number;
  p50: number; p90: number; p95: number; p99: number; max: number;
}

/** Nearest-rank percentile on an already-sorted ascending array. */
export function percentile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  const rank = Math.ceil(q * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))]!;
}

export function summarize(latenciesMs: number[]): LatencyStats {
  if (!latenciesMs.length) return { count: 0, min: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const xs = [...latenciesMs].sort((a, b) => a - b);
  const sum = xs.reduce((s, x) => s + x, 0);
  return {
    count: xs.length,
    min: round(xs[0]!),
    mean: round(sum / xs.length),
    p50: round(percentile(xs, 0.5)),
    p90: round(percentile(xs, 0.9)),
    p95: round(percentile(xs, 0.95)),
    p99: round(percentile(xs, 0.99)),
    max: round(xs[xs.length - 1]!),
  };
}

/** Throughput (items/sec) over a wall-clock window in ms. */
export function throughput(items: number, elapsedMs: number): number {
  return elapsedMs > 0 ? round((items / elapsedMs) * 1000) : 0;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

// ── deterministic synthetic population ──────────────────────────────────────────
// Small curated vocabularies so names/cities repeat realistically (blocking + search have
// something to hit) yet stay deterministic per seed.
const FAMILIES = ["Nguyen", "Garcia", "Smith", "Okafor", "Rivera", "Chen", "Patel", "Kowalski", "Haddad", "Johnson"];
const GIVENS = ["Ana", "Liam", "Yuki", "Chidi", "Mateo", "Wei", "Priya", "Ola", "Sara", "Noah"];
const CITIES: Array<[string, string, string]> = [
  ["Seattle", "WA", "98101"], ["Austin", "TX", "73301"], ["Miami", "FL", "33101"],
  ["Denver", "CO", "80201"], ["Boston", "MA", "02108"],
];
const LOINC = ["8480-6", "8462-4", "2951-2", "718-7", "4548-4"]; // BP, sodium, hgb, hba1c
const SNOMED = ["38341003", "44054006", "195967001", "73211009", "13645005"]; // htn, diabetes, asthma, dm, copd

/** Deterministic pseudo-random in [0,1) from an integer seed (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)]!;

export interface GeneratedPatient { patient: Record<string, unknown>; clinical: Array<Record<string, unknown>> }

/** Generate patient index `i` and `resourcesPerPatient-1` clinical resources referencing it.
 * Deterministic: same (i, resourcesPerPatient) → identical output. */
export function generatePatient(i: number, resourcesPerPatient = 5): GeneratedPatient {
  const r = rng(i + 1);
  const family = pick(r, FAMILIES), given = pick(r, GIVENS);
  const [city, state, postalCode] = pick(r, CITIES);
  const year = 1940 + Math.floor(r() * 70);
  const month = String(1 + Math.floor(r() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(r() * 28)).padStart(2, "0");
  const pid = `bench-p-${i}`;
  const patient = {
    resourceType: "Patient", id: pid,
    identifier: [{ system: "urn:fhirengine:bench:mrn", value: `MRN-${i}` }],
    name: [{ family, given: [given] }],
    gender: r() < 0.5 ? "female" : "male",
    birthDate: `${year}-${month}-${day}`,
    address: [{ city, state, postalCode }],
    telecom: [{ system: "phone", value: `555-${String(1000 + (i % 9000)).padStart(4, "0")}` }],
  };
  const clinical: Array<Record<string, unknown>> = [];
  for (let k = 0; k < Math.max(0, resourcesPerPatient - 1); k++) {
    if (k % 2 === 0) {
      clinical.push({
        resourceType: "Observation", id: `bench-o-${i}-${k}`, status: "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] }],
        code: { coding: [{ system: "http://loinc.org", code: pick(r, LOINC) }] },
        subject: { reference: `Patient/${pid}` },
        effectiveDateTime: `${year + 40}-0${1 + (k % 9)}-15T10:00:00Z`,
        valueQuantity: { value: Math.floor(r() * 200), unit: "mg/dL", system: "http://unitsofmeasure.org" },
      });
    } else {
      clinical.push({
        resourceType: "Condition", id: `bench-c-${i}-${k}`,
        clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
        code: { coding: [{ system: "http://snomed.info/sct", code: pick(r, SNOMED) }] },
        subject: { reference: `Patient/${pid}` },
      });
    }
  }
  return { patient, clinical };
}

/** A transaction Bundle (POST-create entries) for a slice of generated resources. */
export function transactionBundle(resources: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    resourceType: "Bundle", type: "transaction",
    entry: resources.map((r) => ({
      resource: r,
      request: { method: "PUT", url: `${r.resourceType}/${r.id}` },
    })),
  };
}

// ── report formatting ────────────────────────────────────────────────────────────
export interface BenchReport {
  config: Record<string, unknown>;
  ingest: { resources: number; elapsedMs: number; throughputPerSec: number; batchLatency: LatencyStats };
  search: Record<string, LatencyStats>;
  promote?: Record<string, number>;
  optimize?: { elapsedMs: number; searchAfter?: Record<string, LatencyStats> };
}

export function formatReport(rep: BenchReport): string {
  const lines: string[] = [];
  lines.push("=== fhirEngine scale benchmark ===");
  lines.push(`config: ${JSON.stringify(rep.config)}`);
  lines.push("");
  lines.push(`INGEST  ${rep.ingest.resources} resources in ${ms(rep.ingest.elapsedMs)}  →  ${rep.ingest.throughputPerSec}/s`);
  lines.push(`        batch latency ${statLine(rep.ingest.batchLatency)}`);
  lines.push("");
  lines.push("SEARCH latency (ms)   p50 / p95 / p99 / max   (n)");
  for (const [name, s] of Object.entries(rep.search)) {
    lines.push(`  ${name.padEnd(22)} ${String(s.p50).padStart(7)} /${String(s.p95).padStart(7)} /${String(s.p99).padStart(7)} /${String(s.max).padStart(7)}   (${s.count})`);
  }
  if (rep.promote) {
    lines.push("");
    lines.push("PROMOTE (ms)");
    for (const [k, v] of Object.entries(rep.promote)) lines.push(`  ${k.padEnd(22)} ${ms(v)}`);
  }
  if (rep.optimize) {
    lines.push("");
    lines.push(`OPTIMIZE  ${ms(rep.optimize.elapsedMs)}`);
    for (const [name, s] of Object.entries(rep.optimize.searchAfter ?? {})) {
      lines.push(`  after ${name.padEnd(16)} p50=${s.p50} p95=${s.p95} p99=${s.p99}`);
    }
  }
  return lines.join("\n");
}

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);
const statLine = (s: LatencyStats): string => `p50=${s.p50} p95=${s.p95} p99=${s.p99} max=${s.max} mean=${s.mean}`;
