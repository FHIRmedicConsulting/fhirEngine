#!/usr/bin/env node
/**
 * Promotion CLI (ADR-0026) — Bronze → Silver (flattened + governed) + Gold
 * (current-version serving projection). fhirEngine never promotes on its own:
 * in medallion mode the server ingests to Bronze and SERVES from Gold; promotion
 * is run by external orchestration (Dagster / Databricks / cron) — this CLI is the
 * reference implementation (full-rebuild, ADR-0026's idempotent correctness backstop;
 * incremental CDF is available to external promoters — Bronze/Silver tables are
 * created with delta.enableChangeDataFeed=true).
 *
 * Usage:
 *   fhirengine-promote <ResourceType> [ResourceType...]   promote named types (full rebuild)
 *   fhirengine-promote --all                              promote every Bronze table
 *   fhirengine-promote --incremental [...]                CDF-incremental: only ids changed in
 *                                                         Bronze since the last promoted version
 *                                                         (watermark in gold/promote_state; falls
 *                                                         back to full whenever unsafe — Patient
 *                                                         w/ MPI, first run, CDF unavailable)
 */
import { DeltaWarehouse } from "../src/lib/delta-warehouse.js";
import { promote, promoteIncremental, loadSurvivorMap } from "../src/repository/promote.js";
import { r4CoreResourceTypes } from "../src/fhir-schema/r4-registry.js";

/** Bronze table names are lowercased — recover the canonical R4 casing for the flattener. */
const canonical = new Map(r4CoreResourceTypes.map((t) => [t.toLowerCase(), t]));

async function main() {
  const args = process.argv.slice(2);
  const incremental = args.includes("--incremental");
  const wh = new DeltaWarehouse({
    sidecarUrl: process.env.FHIRENGINE_DELTA_SIDECAR_URL ?? "http://127.0.0.1:8077",
    base: process.env.FHIRENGINE_DELTA_BASE ?? "./delta",
  });
  if (!(await wh.health())) throw new Error("delta sidecar not reachable (set FHIRENGINE_DELTA_SIDECAR_URL)");

  let types: string[];
  if (args.includes("--all")) {
    // Discover every Bronze table via the sidecar (works on local FS and object stores).
    const existing = await wh.registerExistingTables();
    types = existing
      .filter((n) => !n.endsWith("_silver") && !n.endsWith("_gold"))
      .map((n) => canonical.get(n) ?? n)
      .filter((n) => canonical.has(n.toLowerCase())); // only R4 resource tables (skip ops tables)
    if (!types.length) { console.log(JSON.stringify({ promoted: 0, note: "no Bronze tables found" })); return; }
  } else {
    types = args.filter((a) => !a.startsWith("--"));
    if (!types.length) {
      console.error("usage: fhirengine-promote <ResourceType> [ResourceType...] | --all");
      process.exitCode = 2;
      return;
    }
  }

  // Patient FIRST: its MPI resolution (ADR-0012 dedup) produces the merged→survivor map
  // every other type's reference rewrite depends on.
  types.sort((a, b) => (a === "Patient" ? -1 : b === "Patient" ? 1 : a.localeCompare(b)));

  const results = [];
  let survivorOf: Map<string, string> | undefined;
  for (const t of types) {
    const t0 = Date.now();
    const opts = t === "Patient" ? undefined : { survivorOf };
    const r = incremental ? await promoteIncremental(wh, t, opts) : await promote(wh, t, opts);
    if (t === "Patient") survivorOf = await loadSurvivorMap(wh);
    results.push({ ...r, ms: Date.now() - t0 });
    const mpiNote = r.merges !== undefined ? ` mpi(merges=${r.merges} reviews=${r.reviews})` : "";
    const modeNote = "mode" in r ? ` [${(r as { mode: string }).mode}]` : "";
    process.stderr.write(`  ${r.resourceType}: bronze=${r.bronzeRows} → gold=${r.gold} silver=${r.silver}${mpiNote}${modeNote}\n`);
  }
  console.log(JSON.stringify({ promoted: results.length, results }, null, 2));
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
