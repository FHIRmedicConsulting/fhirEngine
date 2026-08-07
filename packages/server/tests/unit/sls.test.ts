import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  applySecurityLabels, configureSls, resetSls, slsEnabled,
  HCS_CONFIDENTIALITY_SYSTEM, HCS_SENSITIVITY_SYSTEM,
} from "../../src/security/sls.js";
import type { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";

const ENV = ["FHIRENGINE_SLS_ENABLED", "FHIRENGINE_SLS_RULES", "FHIRENGINE_SLS_BASELINE"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.FHIRENGINE_SLS_ENABLED = "true";
  resetSls();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetSls();
});

const labels = (r: Record<string, unknown>) =>
  (((r.meta as Record<string, unknown>)?.security as Array<{ system: string; code: string }>) ?? []);
const sensOf = (r: Record<string, unknown>) => labels(r).filter((l) => l.system === HCS_SENSITIVITY_SYSTEM).map((l) => l.code).sort();
const confOf = (r: Record<string, unknown>) => labels(r).filter((l) => l.system === HCS_CONFIDENTIALITY_SYSTEM).map((l) => l.code);

const hivCondition = () => ({
  resourceType: "Condition", id: "c1",
  code: { coding: [{ system: "http://snomed.info/sct", code: "86406008" }] },
});
const sudCondition = () => ({
  resourceType: "Condition", id: "c2",
  code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "F11.20" }] },
});
const normalCondition = () => ({
  resourceType: "Condition", id: "c3",
  code: { coding: [{ system: "http://snomed.info/sct", code: "38341003" }] }, // hypertension
});

describe("SLS — demo baseline (ADR-0015 A2.1 example floor)", () => {
  beforeEach(async () => { await configureSls(); });

  it("labels an HIV SNOMED condition: HIV sensitivity + R confidentiality", () => {
    const r = hivCondition();
    const res = applySecurityLabels(r);
    expect(res.labeled).toBe(true);
    expect(res.matchedRules).toContain("hiv-snomed");
    expect(sensOf(r)).toEqual(["HIV"]);
    expect(confOf(r)).toEqual(["R"]);
  });

  it("ICD-10 prefix rules cover the 42 CFR Part 2 F1x family", () => {
    const r = sudCondition();
    applySecurityLabels(r);
    expect(sensOf(r)).toEqual(["ETH", "SUD"]);
    expect(confOf(r)).toEqual(["R"]);
  });

  it("an unremarkable coding gets NO labels (default N is implicit, not written)", () => {
    const r = normalCondition();
    expect(applySecurityLabels(r).labeled).toBe(false);
    expect(labels(r)).toEqual([]);
  });

  it("is idempotent — re-applying adds nothing", () => {
    const r = hivCondition();
    applySecurityLabels(r);
    const snapshot = JSON.stringify(r);
    expect(applySecurityLabels(r).labeled).toBe(false);
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});

describe("SLS — merge policy (A2.5)", () => {
  beforeEach(async () => { await configureSls(); });

  it("preserves source labels and dedupes by (system, code)", () => {
    const r = {
      ...hivCondition(),
      meta: { security: [
        { system: HCS_SENSITIVITY_SYSTEM, code: "HIV" }, // already present from the source EHR
        { system: "http://example.org/custom", code: "SRC" },
      ] },
    };
    applySecurityLabels(r);
    expect(sensOf(r)).toEqual(["HIV"]); // not duplicated
    expect(labels(r).some((l) => l.code === "SRC")).toBe(true); // source label intact
  });

  it("confidentiality is highest-wins with exactly one tag", () => {
    const r = { ...hivCondition(), meta: { security: [{ system: HCS_CONFIDENTIALITY_SYSTEM, code: "N" }] } };
    applySecurityLabels(r);
    expect(confOf(r)).toEqual(["R"]); // N replaced by R
    const r2 = { ...hivCondition(), meta: { security: [{ system: HCS_CONFIDENTIALITY_SYSTEM, code: "V" }] } };
    applySecurityLabels(r2);
    expect(confOf(r2)).toEqual(["V"]); // never downgraded
  });
});

describe("SLS — operator rules + config", () => {
  it("inline FHIRENGINE_SLS_RULES with fieldPath scoping", async () => {
    process.env.FHIRENGINE_SLS_BASELINE = "off";
    process.env.FHIRENGINE_SLS_RULES = JSON.stringify([{
      ruleId: "custom-sex", resourceType: "Observation", fieldPath: "code",
      codeSystem: "http://loinc.org", matchValues: ["82810-3"],
      sensitivity: ["SEX"], confidentiality: "V",
    }]);
    await configureSls();
    const hit = { resourceType: "Observation", id: "o1", code: { coding: [{ system: "http://loinc.org", code: "82810-3" }] } };
    applySecurityLabels(hit);
    expect(sensOf(hit)).toEqual(["SEX"]);
    expect(confOf(hit)).toEqual(["V"]);
    // Same code OUTSIDE the fieldPath → no match (scoping respected).
    const miss = { resourceType: "Observation", id: "o2", component: [{ code: { coding: [{ system: "http://loinc.org", code: "82810-3" }] } }] };
    expect(applySecurityLabels(miss).labeled).toBe(false);
    // Different resource type → no match.
    const wrongType = { resourceType: "Condition", id: "c9", code: { coding: [{ system: "http://loinc.org", code: "82810-3" }] } };
    expect(applySecurityLabels(wrongType).labeled).toBe(false);
  });

  it("matchValueSet rules resolve against the local valueset_expansion table", async () => {
    process.env.FHIRENGINE_SLS_BASELINE = "off";
    process.env.FHIRENGINE_SLS_RULES = JSON.stringify([{
      ruleId: "vsac-c2s", resourceType: "*", matchValueSet: "https://cts.nlm.nih.gov/fhir/ValueSet/c2s-demo",
      sensitivity: ["PSY"], confidentiality: "R",
    }]);
    const wh = {
      registerTerminology: () => "valueset_expansion",
      query: async () => [{ system: "http://snomed.info/sct", code: "191447007" }],
    } as unknown as DeltaWarehouse;
    expect(await configureSls(wh)).toBe(1);
    const r = { resourceType: "Condition", id: "c1", code: { coding: [{ system: "http://snomed.info/sct", code: "191447007" }] } };
    applySecurityLabels(r);
    expect(sensOf(r)).toEqual(["PSY"]);
  });

  it("a matchValueSet rule with an EMPTY expansion is disabled (fail closed per rule)", async () => {
    process.env.FHIRENGINE_SLS_BASELINE = "off";
    process.env.FHIRENGINE_SLS_RULES = JSON.stringify([{
      ruleId: "vs-missing", resourceType: "*", matchValueSet: "http://example.org/not-loaded",
      sensitivity: ["PSY"],
    }]);
    const wh = { registerTerminology: () => "valueset_expansion", query: async () => [] } as unknown as DeltaWarehouse;
    expect(await configureSls(wh)).toBe(0);
  });

  it("malformed operator rules fall back to the baseline only", async () => {
    process.env.FHIRENGINE_SLS_RULES = "{not json";
    await configureSls();
    const r = hivCondition();
    applySecurityLabels(r);
    expect(sensOf(r)).toEqual(["HIV"]); // baseline still active
  });

  it("disabled or unconfigured → strict no-op", async () => {
    await configureSls();
    process.env.FHIRENGINE_SLS_ENABLED = "false";
    expect(slsEnabled()).toBe(false);
    const r = hivCondition();
    expect(applySecurityLabels(r).labeled).toBe(false);
    expect(labels(r)).toEqual([]);
  });

  it("never matches against existing meta.security labels themselves", async () => {
    process.env.FHIRENGINE_SLS_BASELINE = "off";
    process.env.FHIRENGINE_SLS_RULES = JSON.stringify([{
      ruleId: "self-ref", resourceType: "*", codeSystem: HCS_SENSITIVITY_SYSTEM, matchValues: ["HIV"],
      sensitivity: ["ETH"],
    }]);
    await configureSls();
    const r = { resourceType: "Condition", id: "c1", meta: { security: [{ system: HCS_SENSITIVITY_SYSTEM, code: "HIV" }] } };
    expect(applySecurityLabels(r).labeled).toBe(false); // labels are outputs, not match inputs
  });
});
