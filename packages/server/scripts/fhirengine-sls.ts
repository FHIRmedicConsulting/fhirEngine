#!/usr/bin/env node
/**
 * SLS re-classification CLI (ADR-0015 A2.4) — relabel EXISTING resources after a rule-set
 * change or first SLS enablement. Append-only per ADR-0010: a changed label state is written
 * as a NEW resource version (old versions keep their original labels for `_history`).
 *
 * Usage:
 *   FHIRENGINE_SLS_ENABLED=true fhirengine-sls relabel <ResourceType...> | --all [--dry-run]
 *
 * Emits a per-type report {scanned, relabeled} (the A2.4 "delta surfacing" — review before
 * treating the rule set as active for downstream consumers).
 */
import { DeltaWarehouse } from "../src/lib/delta-warehouse.js";
import { bronzeRow } from "../src/repository/ingest.js";
import { configureSls, applySecurityLabels, slsEnabled } from "../src/security/sls.js";
import { r4CoreResourceTypes } from "../src/fhir-schema/r4-registry.js";

const canonical = new Map(r4CoreResourceTypes.map((t) => [t.toLowerCase(), t]));

interface Row { id: string; version_id: number; last_updated: string; body_json: string; deleted: boolean | null }

async function relabelType(wh: DeltaWarehouse, rt: string, dryRun: boolean): Promise<{ resourceType: string; scanned: number; relabeled: number }> {
  const bronze = wh.registerTier("bronze", rt);
  let rows: Row[] = [];
  try {
    rows = await wh.query<Row>(`SELECT id, version_id, last_updated, body_json, deleted FROM ${bronze}`);
  } catch {
    return { resourceType: rt, scanned: 0, relabeled: 0 }; // no table
  }
  const current = new Map<string, Row>();
  for (const r of rows) {
    const prev = current.get(r.id);
    if (!prev || Number(r.version_id) > Number(prev.version_id)) current.set(r.id, r);
  }
  let relabeled = 0;
  for (const r of current.values()) {
    if (r.deleted) continue;
    const resource = JSON.parse(r.body_json) as Record<string, unknown>;
    const { labeled } = applySecurityLabels(resource);
    if (!labeled) continue;
    relabeled++;
    if (dryRun) continue;
    const nextVersion = Number(r.version_id) + 1;
    // bronzeRow re-applies (idempotent) and rebuilds the indexes for the labeled body.
    await wh.writeVersion(rt, bronzeRow(resource as never, nextVersion, new Date().toISOString(), false), Number(r.version_id));
  }
  return { resourceType: rt, scanned: current.size, relabeled };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [cmd, ...rest] = args;
  if (cmd !== "relabel") {
    console.error("usage: fhirengine-sls relabel <ResourceType...> | --all [--dry-run]");
    process.exitCode = 2;
    return;
  }
  if (!slsEnabled()) throw new Error("set FHIRENGINE_SLS_ENABLED=true (and FHIRENGINE_SLS_RULES) to relabel");
  const dryRun = rest.includes("--dry-run");
  const wh = new DeltaWarehouse({
    sidecarUrl: process.env.FHIRENGINE_DELTA_SIDECAR_URL ?? "http://127.0.0.1:8077",
    base: process.env.FHIRENGINE_DELTA_BASE ?? "./delta",
  });
  if (!(await wh.health())) throw new Error("delta sidecar not reachable");
  const ruleCount = await configureSls(wh);
  if (!ruleCount) throw new Error("no SLS rules compiled — nothing to apply");

  let types: string[];
  if (rest.includes("--all")) {
    const existing = await wh.registerExistingTables();
    types = existing
      .filter((n) => !n.endsWith("_silver") && !n.endsWith("_gold"))
      .map((n) => canonical.get(n) ?? n)
      .filter((n) => canonical.has(n.toLowerCase()));
  } else {
    types = rest.filter((a) => !a.startsWith("--"));
    if (!types.length) { console.error("no resource types given"); process.exitCode = 2; return; }
  }

  const results = [];
  for (const t of types) {
    const r = await relabelType(wh, t, dryRun);
    results.push(r);
    if (r.scanned) process.stderr.write(`  ${r.resourceType}: scanned=${r.scanned} relabeled=${r.relabeled}${dryRun ? " (dry-run)" : ""}\n`);
  }
  console.log(JSON.stringify({ rules: ruleCount, dryRun, results: results.filter((r) => r.scanned) }, null, 2));
}

main().catch((e) => { console.error(String((e as Error)?.message ?? e)); process.exitCode = 1; });
