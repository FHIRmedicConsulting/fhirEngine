/**
 * Terminology reconciler — drains the pending-terminology quarantine queue:
 *  1. pull the missing VSAC value sets ($expand, once each),
 *  2. re-validate each quarantined resource,
 *  3. now-valid → ingest to Bronze; genuinely-invalid → dead-letter; still-unknown → keep.
 *
 * `kickReconcile` fires it in the background (single-flight guard) after a quarantine; the
 * CLI `reconcile-terminology` runs it explicitly. Delta is single-writer, so the guard
 * ensures only one reconcile runs at a time.
 */
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { validateResource } from "../validation/validation-chain.js";
import { loadVsacExpansion } from "./sources/vsac.js";
import { bronzeRow } from "../repository/ingest.js";

interface PendingRow {
  [k: string]: unknown;
  row_id: string;
  resource_type: string;
  resource_id: string;
  version_id: number;
  last_updated: string;
  deleted: boolean;
  body_json: string;
  missing: string; // comma-joined ValueSet canonicals
}

export interface ReconcileReport {
  queued: number;
  pulled: Array<{ valueSet: string; expansions: number }>;
  resolved: number;
  deadLettered: number;
  stillPending: number;
}

export async function reconcileTerminology(wh: DeltaWarehouse, opts?: { fetchImpl?: typeof fetch }): Promise<ReconcileReport> {
  const report: ReconcileReport = { queued: 0, pulled: [], resolved: 0, deadLettered: 0, stillPending: 0 };
  wh.registerPendingTerminology();
  let pending: PendingRow[];
  try {
    pending = await wh.query<PendingRow>("SELECT * FROM pending_terminology");
  } catch {
    return report; // queue not provisioned → nothing to do
  }
  report.queued = pending.length;
  if (!pending.length) return report;

  // 1. Pull the distinct missing VSAC value sets (host-matched) once each.
  const missing = new Set<string>();
  for (const p of pending) for (const vs of (p.missing ?? "").split(",").filter(Boolean)) missing.add(vs);
  for (const vs of missing) {
    if (!vs.includes("cts.nlm.nih.gov")) continue; // only VSAC is auto-resolvable
    const oid = vs.split("/ValueSet/")[1]?.split("|")[0] ?? vs;
    try {
      const r = await loadVsacExpansion(wh, oid, opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined);
      report.pulled.push({ valueSet: vs, expansions: r.expansions });
    } catch { /* leave dependent records pending */ }
  }

  // 2. Re-validate each quarantined resource and route it.
  for (const p of pending) {
    const resource = JSON.parse(p.body_json) as Record<string, unknown>;
    const vr = await validateResource(resource, { warehouse: wh });
    if (!vr.valid) {
      await wh.writeDeadLetter(p.resource_type, {
        id: p.resource_id, resourceType: p.resource_type,
        error: vr.issues.map((i) => `${i.path}: ${i.message}`).join("; ").slice(0, 1500),
        body_json: p.body_json, failed_at: new Date().toISOString(),
      });
      await wh.deletePendingTerminology(`row_id = '${p.row_id}'`);
      report.deadLettered++;
    } else if (vr.pending?.length) {
      report.stillPending++; // terminology still not loaded (e.g. non-VSAC) → keep queued
    } else {
      await wh.writeBronze(p.resource_type, bronzeRow(resource as any, p.version_id, p.last_updated, p.deleted));
      await wh.deletePendingTerminology(`row_id = '${p.row_id}'`);
      report.resolved++;
    }
  }
  return report;
}

let running = false;
/** Fire-and-forget background reconcile (single-flight; safe for single-writer Delta).
 * `RONIN_DISABLE_AUTO_RECONCILE=true` → enqueue only; run via the CLI/cron (operator knob). */
export function kickReconcile(wh: DeltaWarehouse): void {
  if (running || process.env.RONIN_DISABLE_AUTO_RECONCILE === "true") return;
  running = true;
  reconcileTerminology(wh).catch(() => { /* surfaced via CLI/logs */ }).finally(() => { running = false; });
}
