/**
 * Benchmark: TS in-process validation (the migrated "best option") vs the Python
 * sidecar validation (IPC + fhir.resources). Structural validation of N resources.
 *
 * Run (sidecar up): RONIN_DELTA_SIDECAR_URL=http://127.0.0.1:8083 \
 *   ./node_modules/.bin/tsx scripts/validation-bench.ts [N]
 */
import { performance } from "node:perf_hooks";
import { validateStructuralOnly } from "../src/validation/validation-chain.js";

const N = Number(process.argv[2] ?? 2000);
const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL ?? "http://127.0.0.1:8083";

function patient(i: number) {
  return {
    resourceType: "Patient",
    id: `bench-${i}`,
    identifier: [{ system: "urn:ronin:mrn", value: `mrn-${i}` }],
    name: [{ family: "Bench", given: ["A", "B"] }],
    gender: i % 2 ? "male" : "female",
    birthDate: "1990-01-01",
    telecom: [{ system: "phone", value: "555-0100" }],
    address: [{ city: "Town", state: "CA", postalCode: "90000" }],
  };
}
const corpus = Array.from({ length: N }, (_, i) => patient(i));

function stats(xs: number[]) {
  xs.sort((a, b) => a - b);
  const p = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  return { p50: +p(0.5).toFixed(3), p95: +p(0.95).toFixed(3), mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) };
}

async function main() {
  // warm
  validateStructuralOnly(corpus[0]);

  // 1) TS in-process
  const tsLat: number[] = [];
  const t0 = performance.now();
  for (const r of corpus) {
    const s = performance.now();
    validateStructuralOnly(r);
    tsLat.push(performance.now() - s);
  }
  const tsTotal = performance.now() - t0;

  // 2) Python sidecar (IPC, one resource per call — the interactive cost)
  let reachable = true;
  try { reachable = (await fetch(`${SIDECAR}/health`)).ok; } catch { reachable = false; }
  const pyLat: number[] = [];
  let pyTotal = 0;
  if (reachable) {
    const p0 = performance.now();
    for (const r of corpus) {
      const s = performance.now();
      await fetch(`${SIDECAR}/validate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resources: [r] }),
      }).then((x) => x.json());
      pyLat.push(performance.now() - s);
    }
    pyTotal = performance.now() - p0;
  }

  console.log(`\n=== Validation benchmark (N=${N} resources) ===`);
  console.log(`TS in-process : ${(N / (tsTotal / 1000)).toFixed(0).padStart(8)} val/s   latency(ms) ${JSON.stringify(stats(tsLat))}`);
  if (reachable) {
    console.log(`Python sidecar: ${(N / (pyTotal / 1000)).toFixed(0).padStart(8)} val/s   latency(ms) ${JSON.stringify(stats(pyLat))}`);
    console.log(`\nTS in-process is ${(pyTotal / tsTotal).toFixed(0)}x faster (no IPC, no Python).`);
  } else {
    console.log("Python sidecar: (unreachable — set RONIN_DELTA_SIDECAR_URL + start the sidecar)");
  }
}
main();
