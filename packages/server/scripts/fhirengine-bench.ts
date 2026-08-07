#!/usr/bin/env node
/**
 * Scale benchmark — ingest throughput + search latency percentiles (+ optional promote/optimize)
 * against a real delta-rs store, driving the in-process app (no network noise).
 *
 * Run (sidecar up):
 *   FHIRENGINE_DELTA_SIDECAR_URL=http://127.0.0.1:8077 FHIRENGINE_DELTA_BASE=./.delta-bench \
 *     npm run bench -- --patients 10000 --resources-per-patient 5 --search-iterations 500 \
 *       [--batch 200] [--promote] [--optimize] [--out report.json]
 *
 * The population is deterministic per index (lib/bench.ts), so a run is reproducible. Numbers are
 * hardware/store-specific — publish them WITH the machine + config, never as absolutes.
 */
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { DeltaWarehouse } from "../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../src/app.js";
import {
  generatePatient, transactionBundle, summarize, throughput, formatReport,
  type BenchReport, type LatencyStats,
} from "../src/lib/bench.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : def;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const num = (name: string, def: number): number => Number(arg(name, String(def))) || def;

async function main(): Promise<void> {
  const patients = num("patients", 1000);
  const rpp = num("resources-per-patient", 5);
  const searchIterations = num("search-iterations", 300);
  const batchResources = num("batch", 200);
  const wh = new DeltaWarehouse({
    sidecarUrl: process.env.FHIRENGINE_DELTA_SIDECAR_URL ?? "http://127.0.0.1:8077",
    base: process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-bench",
  });
  if (!(await wh.health())) throw new Error("delta sidecar not reachable (set FHIRENGINE_DELTA_SIDECAR_URL)");
  const app = createDeltaApp({ warehouse: wh, baseUrl: "http://bench" });
  const post = (path: string, body: unknown) =>
    app.fetch(new Request(`http://bench${path}`, { method: "POST", headers: { "Content-Type": "application/fhir+json" }, body: JSON.stringify(body) }));
  const get = (path: string) => app.fetch(new Request(`http://bench${path}`));

  // Pre-provision the tables (PUT-create 404s on an unprovisioned table) with one of each type.
  const seed0 = generatePatient(0, rpp);
  for (const r of [seed0.patient, ...seed0.clinical]) await post(`/${r.resourceType}`, r);

  // ── INGEST: transaction bundles of ~batchResources, PUT entries, timed per batch ──
  process.stderr.write(`ingesting ${patients} patients × ${rpp} resources…\n`);
  const batchLatency: number[] = [];
  let resourceCount = 0;
  const t0 = performance.now();
  let buffer: Array<Record<string, unknown>> = [];
  const flush = async () => {
    if (!buffer.length) return;
    const b0 = performance.now();
    const res = await post("/", transactionBundle(buffer));
    batchLatency.push(performance.now() - b0);
    if (res.status >= 300) process.stderr.write(`  batch failed: ${res.status}\n`);
    resourceCount += buffer.length;
    buffer = [];
  };
  for (let i = 1; i < patients; i++) { // 0 already provisioned
    const g = generatePatient(i, rpp);
    buffer.push(g.patient, ...g.clinical);
    if (buffer.length >= batchResources) await flush();
    if (i % 2000 === 0) process.stderr.write(`  ${i}/${patients}\n`);
  }
  await flush();
  const ingestMs = performance.now() - t0;

  // ── SEARCH: a representative mix, each timed; round-robin over sampled ids/values ──
  const sampleIdx = Array.from({ length: Math.min(200, patients) }, (_, k) => Math.floor((k / 200) * patients));
  const workloads: Record<string, (i: number) => string> = {
    "read-by-id": (i) => `/Patient/bench-p-${sampleIdx[i % sampleIdx.length]}`,
    "search-_id": (i) => `/Patient?_id=bench-p-${sampleIdx[i % sampleIdx.length]}`,
    "token-identifier": (i) => `/Patient?identifier=MRN-${sampleIdx[i % sampleIdx.length]}`,
    "string-family": () => `/Patient?family=${["Nguyen", "Garcia", "Smith", "Chen", "Patel"][Math.floor(Math.random() * 5)]}`,
    "date-birthdate": () => `/Patient?birthdate=ge1980-01-01&_count=20`,
    "reference-subject": (i) => `/Observation?patient=bench-p-${sampleIdx[i % sampleIdx.length]}`,
    "token-obs-code": () => `/Observation?code=8480-6&_count=20`,
  };
  const runSearch = async (): Promise<Record<string, LatencyStats>> => {
    const out: Record<string, LatencyStats> = {};
    for (const [name, build] of Object.entries(workloads)) {
      const lat: number[] = [];
      for (let i = 0; i < searchIterations; i++) {
        const s = performance.now();
        await get(build(i));
        lat.push(performance.now() - s);
      }
      out[name] = summarize(lat);
    }
    return out;
  };
  process.stderr.write(`running search workload (${searchIterations}× each)…\n`);
  const search = await runSearch();

  const report: BenchReport = {
    config: { patients, resourcesPerPatient: rpp, searchIterations, batchResources, base: process.env.FHIRENGINE_DELTA_BASE },
    ingest: { resources: resourceCount, elapsedMs: Math.round(ingestMs), throughputPerSec: throughput(resourceCount, ingestMs), batchLatency: summarize(batchLatency) },
    search,
  };

  // ── optional PROMOTE (full then incremental) ──
  if (flag("promote")) {
    process.stderr.write("promoting…\n");
    const { promote, promoteIncremental } = await import("../src/repository/promote.js");
    report.promote = {};
    for (const rt of ["Patient", "Observation", "Condition"]) {
      const p0 = performance.now(); await promote(wh, rt); report.promote[`full:${rt}`] = Math.round(performance.now() - p0);
    }
    // incremental no-op pass (nothing changed) to show the fast path
    const inc0 = performance.now(); await promoteIncremental(wh, "Observation"); report.promote["incremental-noop:Observation"] = Math.round(performance.now() - inc0);
  }

  // ── optional OPTIMIZE then re-measure search ──
  if (flag("optimize")) {
    process.stderr.write("optimizing…\n");
    const o0 = performance.now();
    await wh.optimizeAll({ zorder: ["id"] });
    report.optimize = { elapsedMs: Math.round(performance.now() - o0), searchAfter: await runSearch() };
  }

  const out = arg("out");
  if (out) { writeFileSync(out, JSON.stringify(report, null, 2)); process.stderr.write(`report → ${out}\n`); }
  console.log(formatReport(report));
}

main().catch((e) => { console.error(String((e as Error)?.message ?? e)); process.exitCode = 1; });
