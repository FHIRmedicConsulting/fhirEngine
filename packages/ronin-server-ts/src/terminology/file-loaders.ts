/**
 * Operator-supplied terminology loaders — load the large LICENSED code systems
 * (SNOMED CT RF2, LOINC CSV, RxNorm RRF) that IG packages don't carry, into the
 * terminology `codesystem_concept` table via delta-rs. Streamed + batched (these are
 * 100k–500k+ concepts), so memory stays flat.
 *
 * LICENSING (hard rule): these release files are operator-supplied under the operator's
 * own SNOMED/LOINC/RxNorm/UMLS license — never bundled, never committed/redistributed.
 * `display` is always a non-null string (falls back to the code) to keep the Delta column
 * type stable across batches and across systems sharing the table.
 */
import { createReadStream, readdirSync, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";

export const SNOMED_SYS = "http://snomed.info/sct";
export const LOINC_SYS = "http://loinc.org";
export const RXNORM_SYS = "http://www.nlm.nih.gov/research/umls/rxnorm";

interface ConceptRow { system: string; code: string; display: string; version: string | null }
export interface LoadResult { system: string; version: string | null; concepts: number }
export interface LoadOpts { batchSize?: number; limit?: number; descriptions?: boolean; onProgress?: (n: number) => void }

function lines(path: string) {
  return createInterface({ input: createReadStream(path), crlfDelay: Infinity });
}
function findFile(dir: string, re: RegExp): string {
  const f = readdirSync(dir).find((x) => re.test(x));
  if (!f) throw new Error(`no file matching ${re} in ${dir}`);
  return join(dir, f);
}
/** Minimal RFC-4180 line splitter (quotes + "" escapes); assumes no embedded newlines. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === ",") { out.push(cur); cur = ""; }
    else if (ch === '"') q = true;
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Stream rows in batches to `codesystem_concept`, then write a `codesystem_header` row. */
async function loadConcepts(
  wh: DeltaWarehouse,
  system: string,
  version: string | null,
  source: AsyncGenerator<ConceptRow>,
  opts: LoadOpts,
): Promise<LoadResult> {
  const batchSize = opts.batchSize ?? 20000;
  let batch: ConceptRow[] = [];
  let count = 0;
  for await (const row of source) {
    batch.push(row);
    count++;
    if (batch.length >= batchSize) {
      await wh.writeTerminology("codesystem_concept", batch, "append");
      batch = [];
      opts.onProgress?.(count);
    }
    if (opts.limit && count >= opts.limit) break;
  }
  if (batch.length) await wh.writeTerminology("codesystem_concept", batch, "append");
  await wh.writeTerminology("codesystem_header", [{ url: system, version, count, content: "complete" }], "append");
  return { system, version, concepts: count };
}

// ---------------- LOINC (CSV) ----------------
export async function loadLoinc(wh: DeltaWarehouse, dir: string, opts: LoadOpts = {}): Promise<LoadResult> {
  const csv = dir.endsWith(".csv") ? dir
    : existsSync(join(dir, "LoincTableCore", "LoincTableCore.csv")) ? join(dir, "LoincTableCore", "LoincTableCore.csv")
    : existsSync(join(dir, "LoincTableCore.csv")) ? join(dir, "LoincTableCore.csv")
    : join(dir, "LoincTable", "Loinc.csv");
  const version = /Loinc[_-]?([\d.]+)/i.exec(dir)?.[1] ?? null;
  async function* gen(): AsyncGenerator<ConceptRow> {
    let header = true;
    for await (const line of lines(csv)) {
      if (header) { header = false; continue; }
      if (!line) continue;
      const f = splitCsv(line); // LOINC_NUM,COMPONENT,...,LONG_COMMON_NAME(9),SHORTNAME(10),...,STATUS(12)
      const code = f[0];
      if (!code) continue;
      if (f[12] && f[12] !== "ACTIVE") continue; // active LOINCs only
      yield { system: LOINC_SYS, code, display: f[9] || f[10] || code, version };
    }
  }
  return loadConcepts(wh, LOINC_SYS, version, gen(), opts);
}

// ---------------- SNOMED CT (RF2 snapshot) ----------------
export async function loadSnomed(wh: DeltaWarehouse, dir: string, opts: LoadOpts = {}): Promise<LoadResult> {
  const termDir = existsSync(join(dir, "Snapshot", "Terminology")) ? join(dir, "Snapshot", "Terminology") : dir;
  const conceptFile = findFile(termDir, /^sct2_Concept_Snapshot.*\.txt$/);
  const version = /_(\d{8})/.exec(conceptFile)?.[1] ?? null;

  // Build active-FSN display map (unless skipped for speed/testing).
  const display = new Map<string, string>();
  if (opts.descriptions !== false) {
    const descFile = findFile(termDir, /^sct2_Description_Snapshot.*\.txt$/);
    let header = true;
    for await (const line of lines(descFile)) {
      if (header) { header = false; continue; }
      const f = line.split("\t"); // id,eff,active,module,conceptId(4),lang,typeId(6),term(7),case
      if (f[2] !== "1" || f[6] !== "900000000000003001") continue; // active Fully Specified Name
      if (!display.has(f[4]!)) display.set(f[4]!, f[7]!);
    }
  }
  async function* gen(): AsyncGenerator<ConceptRow> {
    let header = true;
    for await (const line of lines(conceptFile)) {
      if (header) { header = false; continue; }
      const f = line.split("\t"); // id(0),eff,active(2),module,definitionStatus
      if (f[2] !== "1") continue; // active concepts only
      yield { system: SNOMED_SYS, code: f[0]!, display: display.get(f[0]!) ?? f[0]!, version };
    }
  }
  return loadConcepts(wh, SNOMED_SYS, version, gen(), opts);
}

// ---------------- RxNorm (RRF) ----------------
export async function loadRxNorm(wh: DeltaWarehouse, dir: string, opts: LoadOpts = {}): Promise<LoadResult> {
  const rrf = existsSync(join(dir, "rrf", "RXNCONSO.RRF")) ? join(dir, "rrf", "RXNCONSO.RRF")
    : existsSync(join(dir, "RXNCONSO.RRF")) ? join(dir, "RXNCONSO.RRF") : dir;
  const version = /_(\d{6,8})/.exec(dir)?.[1] ?? null;
  async function* gen(): AsyncGenerator<ConceptRow> {
    const seen = new Set<string>();
    for await (const line of lines(rrf)) {
      if (!line) continue;
      const f = line.split("|"); // RXCUI(0),LAT(1),...,SAB(11),TTY(12),CODE(13),STR(14)
      if (f[11] !== "RXNORM" || f[1] !== "ENG") continue; // RxNorm-source English atoms
      const code = f[0]!;
      if (seen.has(code)) continue;
      seen.add(code);
      yield { system: RXNORM_SYS, code, display: f[14] || code, version };
    }
  }
  return loadConcepts(wh, RXNORM_SYS, version, gen(), opts);
}

/** Dispatch by system name (CLI). */
export function loadTerminologyFile(wh: DeltaWarehouse, system: string, dir: string, opts: LoadOpts = {}): Promise<LoadResult> {
  switch (system.toLowerCase()) {
    case "loinc": return loadLoinc(wh, dir, opts);
    case "snomed": case "snomedct": case "sct": return loadSnomed(wh, dir, opts);
    case "rxnorm": return loadRxNorm(wh, dir, opts);
    default: throw new Error(`unknown terminology system '${system}' (expected loinc|snomed|rxnorm)`);
  }
}
void statSync; // reserved for future size-based progress
