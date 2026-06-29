import { describe, it, expect } from "vitest";
import { enforce, verbForRequest } from "../../../src/auth/scope-enforcer.js";
import { SmartVersionRegistry, ALL_ACTIVE_VERSIONS } from "../../../src/auth/smart-versions/index.js";
import type { AuthContext } from "../../../src/auth/auth-context.js";

const registry = new SmartVersionRegistry(ALL_ACTIVE_VERSIONS);

function buildAuth(scopeString: string, launchPatient: string | null = null): AuthContext {
  return {
    token: "stub",
    subject: "stub-subject",
    clientId: "stub-client",
    scopes: registry.parseScopeString(scopeString),
    rawScopeString: scopeString,
    launchPatientId: launchPatient,
    launchEncounterId: null,
    fhirUser: null,
    purposeOfUse: null,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    issuer: "stub-idp",
    parsedUnderSmartVersion: "2.2.0",
  };
}

describe("verbForRequest", () => {
  it("maps GET /Resource → s (search)", () => {
    expect(verbForRequest("GET", false)).toBe("s");
  });
  it("maps GET /Resource/{id} → r (read)", () => {
    expect(verbForRequest("GET", true)).toBe("r");
  });
  it("maps POST → c", () => {
    expect(verbForRequest("POST", false)).toBe("c");
  });
  it("maps PUT → u", () => {
    expect(verbForRequest("PUT", true)).toBe("u");
  });
  it("maps PATCH → u", () => {
    expect(verbForRequest("PATCH", true)).toBe("u");
  });
  it("maps DELETE → d", () => {
    expect(verbForRequest("DELETE", true)).toBe("d");
  });
  it("throws on unmapped methods", () => {
    expect(() => verbForRequest("OPTIONS", false)).toThrow();
  });
});

describe("enforce", () => {
  describe("point 2 — ops check", () => {
    it("authorizes read with patient/*.rs scope", () => {
      const auth = buildAuth("patient/*.rs launch/patient", "patient-123");
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.authorized).toBe(true);
    });

    it("authorizes search with patient/*.rs scope (s is in rs)", () => {
      const auth = buildAuth("patient/*.rs launch/patient", "patient-123");
      const result = enforce({ resourceType: "Patient", verb: "s", auth });
      expect(result.authorized).toBe(true);
    });

    it("denies create with patient/*.rs scope (no c in rs)", () => {
      const auth = buildAuth("patient/*.rs launch/patient", "patient-123");
      const result = enforce({ resourceType: "Patient", verb: "c", auth });
      expect(result.authorized).toBe(false);
    });

    it("authorizes full CRUDS with patient/*.cruds", () => {
      const auth = buildAuth("patient/*.cruds launch/patient", "patient-123");
      for (const verb of ["c", "r", "u", "d", "s"] as const) {
        const result = enforce({ resourceType: "Patient", verb, auth });
        expect(result.authorized, `verb=${verb}`).toBe(true);
      }
    });

    it("denies on wrong resource type", () => {
      const auth = buildAuth("system/Coverage.cruds");
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.authorized).toBe(false);
    });

    it("authorizes wildcard resource scope", () => {
      const auth = buildAuth("system/*.rs");
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.authorized).toBe(true);
    });

    it("denies with only non-resource scopes (openid, launch, offline_access)", () => {
      const auth = buildAuth("openid offline_access launch/patient", "patient-123");
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.authorized).toBe(false);
    });

    it("accepts v1 grammar scopes (back-compat)", () => {
      const auth = buildAuth("patient/Patient.read launch/patient", "patient-123");
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.authorized).toBe(true);
    });
  });

  describe("point 3 — granular query restrictions", () => {
    it("surfaces query restrictions from matching scope", () => {
      const auth = buildAuth(
        "patient/Observation.rs?category=laboratory launch/patient",
        "patient-123",
      );
      const result = enforce({ resourceType: "Observation", verb: "r", auth });
      expect(result.authorized).toBe(true);
      expect(result.queryRestrictions.category).toBeDefined();
      expect(Array.from(result.queryRestrictions.category!)).toEqual(["laboratory"]);
    });

    it("unions restrictions across multiple matching scopes", () => {
      const auth = buildAuth(
        "patient/Observation.rs?category=laboratory patient/Observation.rs?category=vital-signs launch/patient",
        "patient-123",
      );
      const result = enforce({ resourceType: "Observation", verb: "r", auth });
      const cats = Array.from(result.queryRestrictions.category ?? []).sort();
      expect(cats).toEqual(["laboratory", "vital-signs"]);
    });

    it("no restrictions when matching scope has none", () => {
      const auth = buildAuth("patient/Observation.rs launch/patient", "patient-123");
      const result = enforce({ resourceType: "Observation", verb: "r", auth });
      expect(result.queryRestrictions).toEqual({});
    });
  });

  describe("point 4 — Patient compartment filter", () => {
    it("applies compartment filter when all matching scopes are patient-context", () => {
      const auth = buildAuth("patient/*.rs launch/patient", "patient-123");
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.patientCompartmentFilter).toBe("patient-123");
    });

    it("does NOT apply compartment filter for system-context scopes", () => {
      const auth = buildAuth("system/*.rs");
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.patientCompartmentFilter).toBeNull();
    });

    it("does NOT apply compartment filter for user-context scopes", () => {
      const auth = buildAuth("user/*.rs");
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.patientCompartmentFilter).toBeNull();
    });

    it("denies patient/* scope without launch/patient context", () => {
      const auth = buildAuth("patient/*.rs"); // no launchPatientId
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.authorized).toBe(false);
      expect(result.denialReason).toMatch(/launch\/patient/);
    });

    it("mixed patient + system scopes: only patient-context constraint applies if both match", () => {
      // When BOTH patient AND system scopes match, allPatientContext is false
      // → no compartment filter. This matches the spec: a wider scope grants
      // wider access.
      const auth = buildAuth("patient/*.rs system/Patient.rs launch/patient", "patient-123");
      const result = enforce({ resourceType: "Patient", verb: "r", auth });
      expect(result.authorized).toBe(true);
      expect(result.patientCompartmentFilter).toBeNull();
    });
  });
});
