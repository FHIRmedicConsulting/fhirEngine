/**
 * Pull-once at IG load: for value sets an IG BINDS but does NOT ship (and that aren't
 * already in Delta), fetch their expansion from VSAC ONCE and materialize into
 * `valueset_expansion`. After this, binding validation is purely local — a single Delta
 * read per check, never a per-validation API call.
 *
 * Only host-matched externals are pulled (default VSAC `cts.nlm.nih.gov`); FHIR-core/THO
 * value sets come from the R4 Core / THO package installs, and PHINVADS is a separate source.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { loadVsacExpansion, type VsacExpandOptions } from "./sources/vsac.js";

/** All value-set canonicals referenced by element bindings in a package's StructureDefinitions. */
export function collectBoundValueSets(packageDir: string): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(packageDir)) {
    if (!f.startsWith("StructureDefinition-") || !f.endsWith(".json")) continue;
    let sd: any;
    try { sd = JSON.parse(readFileSync(join(packageDir, f), "utf8")); } catch { continue; }
    for (const e of sd.snapshot?.element ?? []) {
      const vs = e.binding?.valueSet;
      if (typeof vs === "string") out.add(vs.split("|")[0]);
    }
  }
  return out;
}

export interface PullResult {
  wanted: number;
  alreadyLoaded: number;
  pulled: Array<{ url: string; expansions: number }>;
  failed: Array<{ url: string; error: string }>;
}

export async function pullIgVsacValueSets(
  wh: DeltaWarehouse,
  packageDir: string,
  opts: { hosts?: string[]; vsac?: VsacExpandOptions; limit?: number } = {},
): Promise<PullResult> {
  const wanted = collectBoundValueSets(packageDir);
  wh.registerTerminology("valueset_expansion");
  let loaded = new Set<string>();
  try {
    const rows = await wh.query<{ valueset: string }>("SELECT DISTINCT valueset FROM valueset_expansion");
    loaded = new Set(rows.map((r) => r.valueset));
  } catch { /* table not provisioned yet → nothing loaded */ }

  const hosts = opts.hosts ?? ["cts.nlm.nih.gov"];
  const external = [...wanted].filter((u) => !loaded.has(u) && hosts.some((h) => u.includes(h)));
  const toPull = opts.limit ? external.slice(0, opts.limit) : external;

  const pulled: PullResult["pulled"] = [];
  const failed: PullResult["failed"] = [];
  for (const url of toPull) {
    const oid = url.split("/ValueSet/")[1]?.split("|")[0] ?? url;
    try {
      const r = await loadVsacExpansion(wh, oid, opts.vsac);
      pulled.push({ url, expansions: r.expansions });
    } catch (e: any) {
      failed.push({ url, error: String(e?.message ?? e) }); // never includes the key (see vsac.ts)
    }
  }
  return {
    wanted: wanted.size,
    alreadyLoaded: [...wanted].filter((u) => loaded.has(u)).length,
    pulled,
    failed,
  };
}
