/**
 * DeltaWarehouse round-trip smoke — proves the standalone write+read path:
 * TS → delta-rs sidecar (write raw Bronze) → DataFusion (read) → back, no Spark.
 *
 * Prereq: sidecar running, e.g.
 *   python sidecar/delta_sidecar.py --port 8077 --base ./.delta-smoke
 * Run:  node sidecar/smoke.ts
 */
import { readFileSync } from "node:fs";
import { DeltaWarehouse } from "../src/lib/delta-warehouse.ts";

const wh = new DeltaWarehouse({
  sidecarUrl: process.env.RONIN_DELTA_SIDECAR_URL ?? "http://127.0.0.1:8077",
  base: process.env.RONIN_DELTA_BASE ?? "./.delta-smoke",
});

if (!(await wh.health())) {
  console.error("sidecar not reachable — start delta_sidecar.py first");
  process.exit(1);
}

const patient = JSON.parse(
  readFileSync(
    process.env.PATIENT_EXAMPLE ??
      "/Users/chad/.fhir/packages/hl7.fhir.r4.examples#4.0.1/package/Patient-example.json",
    "utf8",
  ),
);

const idents = (patient.identifier ?? []).map((x: any) => ({
  system: x.system ?? null,
  value: x.value ?? null,
  typeCode: x.type?.coding?.[0]?.code ?? null,
}));

await wh.writeBronze("Patient", {
  id: patient.id,
  version_id: 1,
  last_updated: "2026-06-27T00:00:00Z",
  body_json: JSON.stringify(patient),
  identifier_index: idents,
  ext_json: "{}",
  deleted: false,
  _ingested_at: "2026-06-27T00:00:00Z",
  _ingest_source: "smoke",
});
console.log("1. wrote raw Bronze Patient via delta-rs");

// point read (DataFusion)
const pt = await wh.query(
  "SELECT id, version_id, deleted FROM patient WHERE id = ?",
  [patient.id],
);
console.log("2. point read:", JSON.stringify(pt));

// body round-trip
const body = await wh.query<{ body_json: string }>(
  "SELECT body_json FROM patient WHERE id = ?",
  [patient.id],
);
const back = JSON.parse(body[0].body_json);

// identifier search — Spark exists(arr,lambda) → DataFusion unnest-subquery
const sys = idents[0]?.system;
const val = idents[0]?.value;
const hit = await wh.query(
  `SELECT DISTINCT id FROM (SELECT id, unnest(identifier_index) AS i FROM patient) t
   WHERE t.i.system = ? AND t.i.value = ?`,
  [sys, val],
);
console.log(`3. identifier search (system=${sys}, value=${val}):`, JSON.stringify(hit));

const fails: string[] = [];
if (pt.length !== 1 || pt[0].id !== patient.id) fails.push("point read failed");
if (back.resourceType !== "Patient" || back.id !== patient.id) fails.push("body_json round-trip failed");
if (hit.length !== 1 || (hit[0] as any).id !== patient.id) fails.push("identifier search failed");

console.log("\n=== Assertions ===");
if (fails.length === 0) {
  console.log("✅ ALL PASS — DeltaWarehouse write (delta-rs) + read (DataFusion) round-trip, no Spark/Databricks.");
} else {
  fails.forEach((f) => console.log("  ❌ " + f));
  process.exitCode = 1;
}
await wh.close();
