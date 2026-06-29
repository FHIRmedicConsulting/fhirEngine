import { describe, it, expect } from "vitest";
import { SmartVersionRegistry, ALL_ACTIVE_VERSIONS } from "../../../src/auth/smart-versions/index.js";
import { SmartV1_0_0 } from "../../../src/auth/smart-versions/smart-1-0-0.js";
import { SmartV2_0_0 } from "../../../src/auth/smart-versions/smart-2-0-0.js";
import { SmartV2_2_0 } from "../../../src/auth/smart-versions/smart-2-2-0.js";

describe("SMART scope parsing", () => {
  describe("v1 grammar (under v1.0.0)", () => {
    it("parses patient/Coverage.read → context=patient, resource=Coverage, ops=[r,s]", () => {
      const scope = SmartV1_0_0.parseScope("patient/Coverage.read");
      expect(scope).not.toBeNull();
      expect(scope!.context).toBe("patient");
      expect(scope!.resourceType).toBe("Coverage");
      expect(scope!.operations).toEqual(["r", "s"]);
      expect(scope!.queryRestrictions).toEqual({});
    });

    it("parses patient/*.write → ops=[c,u,d]", () => {
      const scope = SmartV1_0_0.parseScope("patient/*.write");
      expect(scope!.resourceType).toBe("*");
      expect(scope!.operations).toEqual(["c", "u", "d"]);
    });

    it("parses system/Coverage.* → ops=[c,r,u,d,s]", () => {
      const scope = SmartV1_0_0.parseScope("system/Coverage.*");
      expect(scope!.context).toBe("system");
      expect(scope!.operations).toEqual(["c", "r", "u", "d", "s"]);
    });

    it("parses openid / profile / fhirUser / offline_access as non-resource scopes", () => {
      expect(SmartV1_0_0.parseScope("openid")!.context).toBe("openid");
      expect(SmartV1_0_0.parseScope("profile")!.context).toBe("profile");
      expect(SmartV1_0_0.parseScope("fhirUser")!.context).toBe("fhirUser");
      expect(SmartV1_0_0.parseScope("offline_access")!.context).toBe("offline_access");
    });

    it("parses launch and launch/patient", () => {
      expect(SmartV1_0_0.parseScope("launch")!.context).toBe("launch");
      expect(SmartV1_0_0.parseScope("launch/patient")!.context).toBe("launch");
    });

    it("rejects v2 grammar (.rs / .cruds / ?query)", () => {
      expect(SmartV1_0_0.parseScope("patient/Coverage.rs")).toBeNull();
      expect(SmartV1_0_0.parseScope("patient/Coverage.cruds")).toBeNull();
      expect(SmartV1_0_0.parseScope("patient/Observation.rs?category=lab")).toBeNull();
    });

    it("returns null for malformed scopes", () => {
      expect(SmartV1_0_0.parseScope("garbage")).toBeNull();
      expect(SmartV1_0_0.parseScope("patient/Coverage.")).toBeNull();
      expect(SmartV1_0_0.parseScope("patient/.read")).toBeNull();
    });
  });

  describe("v2 grammar (under v2.0.0)", () => {
    it("parses patient/Coverage.rs → ops=[r,s]", () => {
      const scope = SmartV2_0_0.parseScope("patient/Coverage.rs");
      expect(scope!.operations).toEqual(["r", "s"]);
    });

    it("parses patient/Coverage.cruds → ops=[c,r,u,d,s]", () => {
      const scope = SmartV2_0_0.parseScope("patient/Coverage.cruds");
      expect(scope!.operations).toEqual(["c", "r", "u", "d", "s"]);
    });

    it("canonicalizes cruds letter order regardless of input", () => {
      const scope = SmartV2_0_0.parseScope("patient/Coverage.sdurc");
      expect(scope!.operations).toEqual(["c", "r", "u", "d", "s"]);
    });

    it("parses query restrictions", () => {
      const scope = SmartV2_0_0.parseScope(
        "patient/Observation.rs?category=laboratory",
      );
      expect(scope!.queryRestrictions).toEqual({ category: "laboratory" });
    });

    it("parses multiple query restrictions", () => {
      const scope = SmartV2_0_0.parseScope(
        "patient/Observation.rs?category=laboratory&status=final",
      );
      expect(scope!.queryRestrictions).toEqual({
        category: "laboratory",
        status: "final",
      });
    });

    it("rejects duplicate cruds letters", () => {
      expect(SmartV2_0_0.parseScope("patient/Coverage.rr")).toBeNull();
    });

    it("accepts v1 grammar as fallback (spec-required back-compat)", () => {
      const scope = SmartV2_0_0.parseScope("patient/Coverage.read");
      expect(scope!.operations).toEqual(["r", "s"]);
    });
  });

  describe("v2.2.0 specific", () => {
    it("emits authorize-post + jwt-bearer in capabilities/grants", () => {
      expect(SmartV2_2_0.capabilities).toContain("authorize-post");
      expect(SmartV2_2_0.grantTypesSupported).toContain(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
    });
  });

  describe("SmartVersionRegistry — multi-version", () => {
    it("rejects construction with unknown version", () => {
      expect(() => new SmartVersionRegistry(["9.9.9"])).toThrow();
    });

    it("rejects construction with empty active set", () => {
      expect(() => new SmartVersionRegistry([])).toThrow();
    });

    it("parses with first matching version", () => {
      const registry = new SmartVersionRegistry(ALL_ACTIVE_VERSIONS);
      const v1Scope = registry.parseScope("patient/Coverage.read");
      expect(v1Scope).not.toBeNull();
      // Parsed under whichever version's parser accepted it; v1 grammar so
      // parsedUnderVersion is the version of whichever spec's parseScope succeeded.
      expect(v1Scope!.operations).toEqual(["r", "s"]);
    });

    it("unionCapabilities deduplicates across versions", () => {
      const registry = new SmartVersionRegistry(ALL_ACTIVE_VERSIONS);
      const caps = registry.unionCapabilities();
      // Each capability appears once
      expect(new Set(caps).size).toBe(caps.length);
      // permission-v1 + permission-v2 both present
      expect(caps).toContain("permission-v1");
      expect(caps).toContain("permission-v2");
      // backend-services from 2.0.0+
      expect(caps).toContain("backend-services");
      // authorize-post only from 2.2.0
      expect(caps).toContain("authorize-post");
    });

    it("parses a space-separated scope string", () => {
      const registry = new SmartVersionRegistry(ALL_ACTIVE_VERSIONS);
      const scopes = registry.parseScopeString(
        "patient/Coverage.rs patient/Patient.r launch/patient openid offline_access",
      );
      expect(scopes).toHaveLength(5);
    });

    it("skips unparseable scopes in a space-separated string", () => {
      const registry = new SmartVersionRegistry(ALL_ACTIVE_VERSIONS);
      const scopes = registry.parseScopeString("patient/Coverage.rs garbage openid");
      expect(scopes).toHaveLength(2);
    });

    it("supports running with strict_federal (latest only) active set", () => {
      const registry = new SmartVersionRegistry(["2.2.0"]);
      expect(registry.unionCapabilities()).toContain("authorize-post");
      // Still accepts v1 grammar because 2.2.0 spec accepts legacy
      expect(registry.parseScope("patient/Coverage.read")).not.toBeNull();
    });
  });
});
