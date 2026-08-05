import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLoinc, loadSnomed, loadRxNorm, loadTerminologyFile,
  LOINC_SYS, SNOMED_SYS, RXNORM_SYS,
} from "../../src/terminology/file-loaders.js";
import type { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";

const tmp = mkdtempSync(join(tmpdir(), "fhirengine-terminology-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const writeTerminology = vi.fn(async () => {});
const wh = { writeTerminology } as unknown as DeltaWarehouse;
beforeEach(() => writeTerminology.mockClear());

/** All concept rows written across every batch for a table. */
const written = (table: string) =>
  writeTerminology.mock.calls.filter((c: any[]) => c[0] === table).flatMap((c: any[]) => c[1]);

// ---------------- LOINC fixture ----------------
// Columns: LOINC_NUM(0) ... LONG_COMMON_NAME(9) SHORTNAME(10) ... STATUS(12)
const loincRow = (code: string, long: string, short: string, status: string) =>
  [code, "comp", "prop", "time", "system", "scale", "method", "class", "vname", long, short, "x", status].join(",");

const loincDir = join(tmp, "Loinc_2.77");
mkdirSync(join(loincDir, "LoincTableCore"), { recursive: true });
writeFileSync(join(loincDir, "LoincTableCore", "LoincTableCore.csv"), [
  "LOINC_NUM,COMPONENT,PROPERTY,TIME_ASPCT,SYSTEM,SCALE_TYP,METHOD_TYP,CLASS,VERSIONLASTCHANGED,LONG_COMMON_NAME,SHORTNAME,EXTERNAL_COPYRIGHT_NOTICE,STATUS",
  loincRow("8480-6", '"Systolic blood pressure, sitting"', "BP sys", "ACTIVE"),
  loincRow("1234-5", "", "Short B", ""), // empty status → kept
  loincRow("9999-9", "Deprecated thing", "Dep", "DEPRECATED"), // skipped
  loincRow("", "No code", "None", "ACTIVE"), // skipped
  loincRow("5555-5", '"He said ""hi"""', "Esc", "ACTIVE"), // "" escape
  "",
].join("\n"));

describe("loadLoinc", () => {
  it("streams active concepts with RFC-4180 parsing, then writes the header row", async () => {
    const r = await loadLoinc(wh, loincDir);
    expect(r).toEqual({ system: LOINC_SYS, version: "2.77", concepts: 3 });
    const rows = written("codesystem_concept");
    expect(rows).toEqual([
      { system: LOINC_SYS, code: "8480-6", display: "Systolic blood pressure, sitting", version: "2.77" },
      { system: LOINC_SYS, code: "1234-5", display: "Short B", version: "2.77" }, // long name empty → SHORTNAME
      { system: LOINC_SYS, code: "5555-5", display: 'He said "hi"', version: "2.77" },
    ]);
    expect(written("codesystem_header")).toEqual([
      { url: LOINC_SYS, version: "2.77", count: 3, content: "complete" },
    ]);
    // every write is an append (never overwrite a shared table)
    expect(writeTerminology.mock.calls.every((c: any[]) => c[2] === "append")).toBe(true);
  });

  it("batches writes and reports progress per full batch", async () => {
    const onProgress = vi.fn();
    await loadLoinc(wh, loincDir, { batchSize: 1, onProgress });
    const conceptWrites = writeTerminology.mock.calls.filter((c: any[]) => c[0] === "codesystem_concept");
    expect(conceptWrites).toHaveLength(3); // one write per single-row batch
    expect(conceptWrites.every((c: any[]) => (c[1] as unknown[]).length === 1)).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(3);
  });

  it("honors the row limit and records the limited count in the header", async () => {
    const r = await loadLoinc(wh, loincDir, { limit: 2 });
    expect(r.concepts).toBe(2);
    expect(written("codesystem_header")).toEqual([
      { url: LOINC_SYS, version: "2.77", count: 2, content: "complete" },
    ]);
  });

  it("accepts a direct .csv path", async () => {
    const csv = join(tmp, "standalone.csv");
    writeFileSync(csv, ["HEADER", loincRow("2951-2", "Sodium", "Na", "ACTIVE")].join("\n"));
    const r = await loadLoinc(wh, csv);
    expect(r.concepts).toBe(1);
    expect(written("codesystem_concept")[0]).toMatchObject({ code: "2951-2", display: "Sodium" });
  });
});

// ---------------- SNOMED fixture (RF2 snapshot) ----------------
const snomedDir = join(tmp, "SnomedCT_Release");
const termDir = join(snomedDir, "Snapshot", "Terminology");
mkdirSync(termDir, { recursive: true });
// id, effectiveTime, active, moduleId, definitionStatusId
writeFileSync(join(termDir, "sct2_Concept_Snapshot_INT_20240301.txt"), [
  "id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId",
  "38341003\t20240301\t1\tcore\tprimitive",
  "111111\t20240301\t0\tcore\tprimitive", // inactive → skipped
  "222222\t20240301\t1\tcore\tprimitive", // no FSN → display falls back to code
].join("\n"));
// id, effectiveTime, active, moduleId, conceptId, languageCode, typeId, term, caseSignificanceId
const FSN = "900000000000003001";
writeFileSync(join(termDir, "sct2_Description_Snapshot-en_INT_20240301.txt"), [
  "id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId",
  `d1\t20240301\t1\tcore\t38341003\ten\t${FSN}\tHypertensive disorder (disorder)\tci`,
  `d2\t20240301\t1\tcore\t38341003\ten\t${FSN}\tLater duplicate FSN (ignored)\tci`, // first FSN wins
  `d3\t20240301\t0\tcore\t222222\ten\t${FSN}\tInactive FSN (ignored)\tci`,
  `d4\t20240301\t1\tcore\t222222\ten\t900000000000013009\tA synonym, not an FSN\tci`,
].join("\n"));

describe("loadSnomed", () => {
  it("loads active concepts with their active FSN display; falls back to the code", async () => {
    const r = await loadSnomed(wh, snomedDir);
    expect(r).toEqual({ system: SNOMED_SYS, version: "20240301", concepts: 2 });
    expect(written("codesystem_concept")).toEqual([
      { system: SNOMED_SYS, code: "38341003", display: "Hypertensive disorder (disorder)", version: "20240301" },
      { system: SNOMED_SYS, code: "222222", display: "222222", version: "20240301" },
    ]);
    expect(written("codesystem_header")).toEqual([
      { url: SNOMED_SYS, version: "20240301", count: 2, content: "complete" },
    ]);
  });

  it("descriptions:false skips the FSN pass (display = code)", async () => {
    await loadSnomed(wh, snomedDir, { descriptions: false });
    expect(written("codesystem_concept").map((c: any) => c.display)).toEqual(["38341003", "222222"]);
  });

  it("throws a clear error when the RF2 concept file is missing", async () => {
    const empty = join(tmp, "not-snomed");
    mkdirSync(empty, { recursive: true });
    await expect(loadSnomed(wh, empty)).rejects.toThrow(/no file matching/);
  });
});

// ---------------- RxNorm fixture (RRF) ----------------
// RXCUI(0)|LAT(1)|...|SAB(11)|TTY(12)|CODE(13)|STR(14)|
const rrfRow = (rxcui: string, lat: string, sab: string, tty: string, str: string) =>
  [rxcui, lat, "TS", "LUI", "STT", "SUI", "Y", "RXAUI", "", "", "", sab, tty, rxcui, str, ""].join("|");

const rxnormDir = join(tmp, "RxNorm_full_06032024");
mkdirSync(rxnormDir, { recursive: true });
writeFileSync(join(rxnormDir, "RXNCONSO.RRF"), [
  rrfRow("161", "ENG", "RXNORM", "IN", "Acetaminophen"),
  rrfRow("161", "ENG", "RXNORM", "PIN", "Acetaminophen (duplicate RXCUI)"), // deduped
  rrfRow("161", "FRE", "RXNORM", "IN", "Acétaminophène"), // non-English → skipped
  rrfRow("212", "ENG", "MSH", "MH", "MeSH atom"), // non-RXNORM source → skipped
  rrfRow("313", "ENG", "RXNORM", "IN", ""), // empty STR → display falls back to code
  "",
].join("\n"));

describe("loadRxNorm", () => {
  it("keeps first English RXNORM atom per RXCUI; version from the release dir name", async () => {
    const r = await loadRxNorm(wh, rxnormDir);
    expect(r).toEqual({ system: RXNORM_SYS, version: "06032024", concepts: 2 });
    expect(written("codesystem_concept")).toEqual([
      { system: RXNORM_SYS, code: "161", display: "Acetaminophen", version: "06032024" },
      { system: RXNORM_SYS, code: "313", display: "313", version: "06032024" },
    ]);
  });
});

describe("loadTerminologyFile dispatch", () => {
  it("dispatches by system name, case-insensitively", async () => {
    const r = await loadTerminologyFile(wh, "SNOMEDCT", snomedDir, { descriptions: false });
    expect(r.system).toBe(SNOMED_SYS);
  });

  it("rejects unknown systems", () => {
    expect(() => loadTerminologyFile(wh, "icd10", tmp)).toThrow(/unknown terminology system/);
  });
});
