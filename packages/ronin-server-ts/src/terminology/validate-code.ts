/**
 * `$validate-code` — pure-local terminology validation over the Delta-backed store
 * (DataFusion). The keystone op for L3 binding validation.
 *
 * Three-state result so binding validation can degrade gracefully (per the research's
 * "unknown ≠ invalid" rule): if the ValueSet/CodeSystem isn't loaded, return `unknown`
 * (a warning) rather than failing a code we simply can't check.
 */
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";

export interface ValidateCodeParams {
  code: string;
  /** ValueSet canonical URL — checks membership in its expansion. */
  valueSet?: string;
  /** CodeSystem URL — checks the code exists in the system. */
  system?: string;
}

export type ValidateCodeStatus = "valid" | "invalid" | "unknown";

export interface ValidateCodeResult {
  result: boolean;
  status: ValidateCodeStatus;
  display: string | null;
  message?: string;
}

export async function validateCode(
  wh: DeltaWarehouse,
  p: ValidateCodeParams,
): Promise<ValidateCodeResult> {
  if (p.valueSet) {
    wh.registerTerminology("valueset_expansion");
    const hit = await wh.query<{ display: string | null }>(
      p.system
        ? "SELECT display FROM valueset_expansion WHERE valueset = ? AND code = ? AND system = ? LIMIT 1"
        : "SELECT display FROM valueset_expansion WHERE valueset = ? AND code = ? LIMIT 1",
      p.system ? [p.valueSet, p.code, p.system] : [p.valueSet, p.code],
    );
    if (hit.length) return { result: true, status: "valid", display: hit[0].display };
    // Distinguish "not in VS" (invalid) from "VS not loaded" (unknown).
    const loaded = await wh.query("SELECT 1 FROM valueset_expansion WHERE valueset = ? LIMIT 1", [p.valueSet]);
    return loaded.length
      ? { result: false, status: "invalid", display: null, message: `code '${p.code}' not in ValueSet ${p.valueSet}` }
      : { result: false, status: "unknown", display: null, message: `ValueSet ${p.valueSet} not loaded` };
  }
  if (p.system) {
    wh.registerTerminology("codesystem_concept");
    const hit = await wh.query<{ display: string | null }>(
      "SELECT display FROM codesystem_concept WHERE system = ? AND code = ? LIMIT 1",
      [p.system, p.code],
    );
    if (hit.length) return { result: true, status: "valid", display: hit[0].display };
    const loaded = await wh.query("SELECT 1 FROM codesystem_concept WHERE system = ? LIMIT 1", [p.system]);
    return loaded.length
      ? { result: false, status: "invalid", display: null, message: `code '${p.code}' not in CodeSystem ${p.system}` }
      : { result: false, status: "unknown", display: null, message: `CodeSystem ${p.system} not loaded` };
  }
  return { result: false, status: "unknown", display: null, message: "validate-code requires a valueSet or system" };
}
