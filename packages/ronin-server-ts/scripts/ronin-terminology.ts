#!/usr/bin/env node
/**
 * Provisioning CLI — load FHIR packages (IGs: profiles + carried terminology) and the
 * large operator-supplied code systems (SNOMED/LOINC/RxNorm). The command logic lives in
 * shared modules (file-loaders, ig-loader, terminology-loader) so a future authenticated
 * admin endpoint can reuse the same core once the security port lands.
 *
 * Storage follows the topology ([[storage-topology]]): RONIN_STORAGE_MODE=single|medallion.
 * Run under 1Password for any API keys:  op run --env-file=… -- ronin-terminology …
 *
 * Usage:
 *   ronin-terminology load-terminology <loinc|snomed|rxnorm> <dir> [--limit N] [--no-descriptions]
 *   ronin-terminology install-ig <packageDir> [packageId]
 */
import { readFileSync } from "node:fs";
import { DeltaWarehouse } from "../src/lib/delta-warehouse.js";
import { loadTerminologyFile } from "../src/terminology/file-loaders.js";
import { installIgPackage } from "../src/conformance/ig-loader.js";
import { loadVsacExpansion } from "../src/terminology/sources/vsac.js";
import { pullIgVsacValueSets } from "../src/terminology/ig-valuesets.js";
import { runTerminologyUpdate, loadedTerminologyVersions } from "../src/terminology/updater.js";
import { reconcileTerminology } from "../src/terminology/reconcile.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const wh = new DeltaWarehouse({
    sidecarUrl: process.env.RONIN_DELTA_SIDECAR_URL ?? "http://127.0.0.1:8077",
    base: process.env.RONIN_DELTA_BASE ?? "./delta",
    // storageMode resolved from RONIN_STORAGE_MODE by the warehouse.
  });
  if (!(await wh.health())) throw new Error("delta sidecar not reachable (set RONIN_DELTA_SIDECAR_URL)");

  switch (cmd) {
    case "load-terminology": {
      const [system, dir] = rest;
      if (!system || !dir) throw new Error("usage: load-terminology <loinc|snomed|rxnorm> <dir> [--limit N] [--no-descriptions]");
      const limit = flag(rest, "--limit") ? Number(flag(rest, "--limit")) : undefined;
      const descriptions = !rest.includes("--no-descriptions");
      const t0 = Date.now();
      const r = await loadTerminologyFile(wh, system, dir, {
        limit, descriptions,
        onProgress: (n) => process.stderr.write(`\r  loaded ${n} concepts…`),
      });
      process.stderr.write("\n");
      console.log(JSON.stringify({ ...r, ms: Date.now() - t0 }));
      break;
    }
    case "install-ig": {
      const [pkgDir, pkgId] = rest.filter((a) => !a.startsWith("--"));
      if (!pkgDir) throw new Error("usage: install-ig <packageDir> [packageId] [--pull-vsac]");
      const r = await installIgPackage(wh, pkgDir, pkgId ?? pkgDir);
      const out: any = { install: r };
      if (rest.includes("--pull-vsac")) {
        // Pull-once at load: materialize the IG's external VSAC value sets into Delta.
        out.vsac = await pullIgVsacValueSets(wh, pkgDir);
      }
      console.log(JSON.stringify(out));
      break;
    }
    case "pull-ig-valuesets": {
      // Pull (once) the external VSAC value sets an already-installed IG binds but didn't ship.
      const pkgDir = rest.find((a) => !a.startsWith("--"));
      if (!pkgDir) throw new Error("usage: pull-ig-valuesets <packageDir>   (UMLS_API_KEY via op run)");
      console.log(JSON.stringify(await pullIgVsacValueSets(wh, pkgDir), null, 2));
      break;
    }
    case "expand-vsac": {
      // expand-vsac <oid...> — pull VSAC expansions (needs UMLS_API_KEY via op run).
      if (!rest.length) throw new Error("usage: expand-vsac <valueSetOid> [oid...]");
      const out = [];
      for (const oid of rest) out.push(await loadVsacExpansion(wh, oid));
      console.log(JSON.stringify(out));
      break;
    }
    case "check-updates": {
      console.log(JSON.stringify(await loadedTerminologyVersions(wh), null, 2));
      break;
    }
    case "reconcile-terminology": {
      // Drain the pending-terminology quarantine queue: pull missing VSAC sets + re-validate.
      console.log(JSON.stringify(await reconcileTerminology(wh), null, 2));
      break;
    }
    case "optimize": {
      // Compact small files (+ optional vacuum). Default: ALL tables in the store.
      // Flags: --vacuum  --retention-hours N (default 168)  --force (drop retention enforcement; dev)
      // Named terminology tables only: optimize codesystem_concept valueset_expansion …
      const opts = {
        vacuum: rest.includes("--vacuum"),
        retentionHours: flag(rest, "--retention-hours") ? Number(flag(rest, "--retention-hours")) : 168,
        force: rest.includes("--force"),
      };
      const tables = rest.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
      if (tables.length === 0) {
        console.log(JSON.stringify(await wh.optimizeAll(opts), null, 2)); // whole store
      } else {
        const out: Record<string, unknown> = {};
        for (const t of tables) out[t] = await wh.optimizeTerminology(t, opts);
        console.log(JSON.stringify(out, null, 2));
      }
      break;
    }
    case "update": {
      // update <configFile.json> — operator-picked sources/modes.
      const cfgPath = rest[0];
      if (!cfgPath) throw new Error("usage: update <configFile.json>");
      const config = JSON.parse(readFileSync(cfgPath, "utf8"));
      console.log(JSON.stringify(await runTerminologyUpdate(wh, config), null, 2));
      break;
    }
    default:
      console.error([
        "commands:",
        "  load-terminology <loinc|snomed|rxnorm> <dir> [--limit N] [--no-descriptions]",
        "  install-ig <packageDir> [packageId] [--pull-vsac]",
        "  pull-ig-valuesets <packageDir>           (pull IG's external VSAC sets once; op run)",
        "  expand-vsac <valueSetOid> [oid...]      (UMLS_API_KEY via op run)",
        "  check-updates                            (report loaded versions)",
        "  optimize [--vacuum] [--retention-hours N] [--force] [table...]  (compact whole store; tables = terminology only)",
        "  update <configFile.json>                 (operator-picked sources/modes)",
        "  reconcile-terminology                    (drain pending-terminology queue)",
      ].join("\n"));
      process.exitCode = 2;
  }
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
