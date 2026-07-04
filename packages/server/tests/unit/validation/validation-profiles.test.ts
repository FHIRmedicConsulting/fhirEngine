/**
 * Operator-configured profile enforcement (FHIRENGINE_VALIDATION_PROFILES) + the
 * slice-qualified-binding regression: a slice's required binding lives under an element
 * *id* like `Condition.category:screening` (path stays `Condition.category`) and must not
 * be applied to every node at the path — that false-rejected valid US Core problem-list
 * Conditions against the screening-assessment category ValueSet.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateResource, resetValidationCaches } from "../../../src/validation/validation-chain.js";
import type { DeltaWarehouse } from "../../../src/lib/delta-warehouse.js";

const PROFILE_URL = "http://example.org/StructureDefinition/test-patient";

/** Minimal installed-profile snapshot: Patient with a required `name`. */
const patientProfile = {
  url: PROFILE_URL,
  type: "Patient",
  derivation: "constraint",
  snapshot: {
    element: [
      { id: "Patient", path: "Patient", min: 0 },
      { id: "Patient.name", path: "Patient.name", min: 1 },
    ],
  },
};

/** Profile whose only category binding is slice-qualified — must NOT be enforced globally. */
const slicedProfile = {
  url: PROFILE_URL,
  type: "Patient",
  derivation: "constraint",
  snapshot: {
    element: [
      { id: "Patient", path: "Patient", min: 0 },
      {
        id: "Patient.maritalStatus:screening",
        path: "Patient.maritalStatus",
        sliceName: "screening",
        min: 0,
        type: [{ code: "CodeableConcept" }],
        binding: { strength: "required", valueSet: "http://example.org/vs/screening-only" },
      },
    ],
  },
};

/** Same binding but on the element itself (no slice) — control: still enforced. */
const boundProfile = {
  ...slicedProfile,
  snapshot: {
    element: [
      { id: "Patient", path: "Patient", min: 0 },
      {
        id: "Patient.maritalStatus",
        path: "Patient.maritalStatus",
        min: 0,
        type: [{ code: "CodeableConcept" }],
        binding: { strength: "required", valueSet: "http://example.org/vs/screening-only" },
      },
    ],
  },
};

/** Stub warehouse: routes the validator's conformance/terminology queries to fixtures. */
function stubWarehouse(sd: typeof patientProfile, pkg = "test.pkg"): DeltaWarehouse {
  const expansionMembers = [{ valueset: "http://example.org/vs/screening-only", code: "screening-code" }];
  return {
    registerConformance() {},
    registerTerminology() {},
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("FROM structuredefinition")) {
        if (sql.includes("package = ?")) return params[0] === pkg && params[1] === sd.type ? [{ url: sd.url }] : [];
        if (sql.includes("url = ? AND type = ?")) return params[0] === sd.url && params[1] === sd.type ? [{ url: sd.url }] : [];
        return params[0] === sd.url ? [{ json: JSON.stringify(sd) }] : [];
      }
      if (sql.includes("FROM valueset_expansion")) {
        if (sql.includes("code = ?")) {
          return expansionMembers.filter((e) => e.valueset === params[0] && e.code === params[1]).map(() => ({ display: null }));
        }
        return expansionMembers.some((e) => e.valueset === params[0]) ? [{ ok: 1 }] : [];
      }
      return [];
    },
  } as unknown as DeltaWarehouse;
}

const savedEnv = process.env.FHIRENGINE_VALIDATION_PROFILES;
beforeEach(() => resetValidationCaches());
afterEach(() => {
  if (savedEnv === undefined) delete process.env.FHIRENGINE_VALIDATION_PROFILES;
  else process.env.FHIRENGINE_VALIDATION_PROFILES = savedEnv;
  resetValidationCaches();
});

describe("FHIRENGINE_VALIDATION_PROFILES — operator-configured enforcement", () => {
  const claimsButViolates = { resourceType: "Patient", meta: { profile: [PROFILE_URL] } }; // no name

  it("default (unset): meta.profile claims are NOT enforced — base FHIR only", async () => {
    delete process.env.FHIRENGINE_VALIDATION_PROFILES;
    const vr = await validateResource({ ...claimsButViolates }, { warehouse: stubWarehouse(patientProfile) });
    expect(vr.valid).toBe(true);
  });

  it("'declared': a claimed profile is enforced", async () => {
    process.env.FHIRENGINE_VALIDATION_PROFILES = "declared";
    const vr = await validateResource({ ...claimsButViolates }, { warehouse: stubWarehouse(patientProfile) });
    expect(vr.valid).toBe(false);
    expect(vr.issues.map((i) => i.message).join()).toContain("requires element 'name'");
  });

  it("package id: the package's profile is enforced even without a meta.profile claim", async () => {
    process.env.FHIRENGINE_VALIDATION_PROFILES = "test.pkg";
    const vr = await validateResource({ resourceType: "Patient" }, { warehouse: stubWarehouse(patientProfile) });
    expect(vr.valid).toBe(false);
    expect(vr.issues.map((i) => i.message).join()).toContain("requires element 'name'");
  });

  it("canonical URL: that profile is enforced; a satisfying resource passes", async () => {
    process.env.FHIRENGINE_VALIDATION_PROFILES = PROFILE_URL;
    const wh = stubWarehouse(patientProfile);
    expect((await validateResource({ resourceType: "Patient" }, { warehouse: wh })).valid).toBe(false);
    resetValidationCaches();
    expect((await validateResource({ resourceType: "Patient", name: [{ family: "X" }] }, { warehouse: wh })).valid).toBe(true);
  });

  it("unknown package id: nothing to enforce → base validation only", async () => {
    process.env.FHIRENGINE_VALIDATION_PROFILES = "no.such.pkg";
    const vr = await validateResource({ ...claimsButViolates }, { warehouse: stubWarehouse(patientProfile) });
    expect(vr.valid).toBe(true);
  });
});

describe("slice-qualified required bindings", () => {
  const offValueSet = { resourceType: "Patient", maritalStatus: { coding: [{ code: "not-a-member" }] } };

  it("a binding under a slice id is NOT applied to every node at the path", async () => {
    process.env.FHIRENGINE_VALIDATION_PROFILES = "test.pkg";
    const vr = await validateResource({ ...offValueSet }, { warehouse: stubWarehouse(slicedProfile) });
    expect(vr.valid).toBe(true);
  });

  it("control: the same binding on the unsliced element is still enforced", async () => {
    process.env.FHIRENGINE_VALIDATION_PROFILES = "test.pkg";
    const vr = await validateResource({ ...offValueSet }, { warehouse: stubWarehouse(boundProfile) });
    expect(vr.valid).toBe(false);
    expect(vr.issues.map((i) => i.message).join()).toContain("no coding in required ValueSet");
  });
});
