import { describe, it, expect } from "vitest";
import { buildDataFilter } from "../../src/auth/data-filter.js";
import type { AuthContext } from "../../src/auth/auth-context.js";
import type { CanonicalScope, ScopeContext, ScopeOperation } from "../../src/auth/smart-versions/types.js";
import { FhirError } from "../../src/lib/errors.js";

function scope(
  context: ScopeContext,
  resourceType: string | null,
  operations: ScopeOperation[],
  queryRestrictions: Record<string, string> = {},
): CanonicalScope {
  return { context, resourceType, operations, queryRestrictions, rawScope: `${context}/${resourceType}`, parsedUnderVersion: "2.0" };
}

function auth(scopes: CanonicalScope[], launchPatientId: string | null = null): AuthContext {
  return {
    token: "t", subject: "sub-1", clientId: "client-1", scopes, rawScopeString: "",
    launchPatientId, launchEncounterId: null, fhirUser: null, purposeOfUse: null,
    expiresAt: 0, issuer: "https://idp.example", parsedUnderSmartVersion: "2.0",
  };
}

describe("buildDataFilter", () => {
  it("system scope reads with no compartment filter and no restrictions", () => {
    const df = buildDataFilter(auth([scope("system", "Observation", ["r", "s"])]), "Observation", "s");
    expect(df.patientCompartmentId).toBeNull();
    expect(df.queryRestrictions).toEqual({});
  });

  it("patient scope + launch context pins the patient compartment", () => {
    const df = buildDataFilter(auth([scope("patient", "Observation", ["r", "s"])], "pat-42"), "Observation", "r");
    expect(df.patientCompartmentId).toBe("pat-42");
  });

  it("FAILS CLOSED: no matching scope throws forbidden (403), never an empty filter", () => {
    try {
      buildDataFilter(auth([]), "Observation", "s");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FhirError);
      expect((e as FhirError).status).toBe(403);
    }
  });

  it("FAILS CLOSED: patient scope without launch/patient context throws forbidden", () => {
    expect(() => buildDataFilter(auth([scope("patient", "Patient", ["r", "s"])], null), "Patient", "r"))
      .toThrowError(/launch\/patient/);
  });

  it("FAILS CLOSED: verb not in the granted operations throws forbidden", () => {
    expect(() => buildDataFilter(auth([scope("system", "Patient", ["r", "s"])]), "Patient", "d"))
      .toThrowError(FhirError);
  });

  it("FAILS CLOSED: scope for a different resource type does not authorize", () => {
    expect(() => buildDataFilter(auth([scope("system", "Patient", ["r", "s"])]), "Observation", "r"))
      .toThrowError(FhirError);
  });

  it("wildcard resource scope authorizes any type", () => {
    const df = buildDataFilter(auth([scope("system", "*", ["r", "s"])]), "Condition", "s");
    expect(df.patientCompartmentId).toBeNull();
  });

  it("non-resource scopes (openid, launch) never authorize FHIR reads", () => {
    expect(() => buildDataFilter(auth([scope("openid", null, [])]), "Patient", "r"))
      .toThrowError(FhirError);
  });

  it("unions query restrictions across matching scopes with sorted values", () => {
    const a = auth([
      scope("system", "Observation", ["r", "s"], { category: "vital-signs" }),
      scope("system", "Observation", ["r", "s"], { category: "laboratory" }),
    ]);
    const df = buildDataFilter(a, "Observation", "s");
    expect(df.queryRestrictions).toEqual({ category: ["laboratory", "vital-signs"] });
  });

  it("mixed patient+user matching scopes drop the compartment filter (user scope is broader)", () => {
    const a = auth([
      scope("patient", "Observation", ["r", "s"]),
      scope("user", "Observation", ["r", "s"]),
    ], "pat-42");
    const df = buildDataFilter(a, "Observation", "r");
    expect(df.patientCompartmentId).toBeNull();
  });

  it("restriction values are copied per key, not shared across keys", () => {
    const a = auth([
      scope("system", "Observation", ["s"], { category: "laboratory" }),
      scope("system", "Observation", ["s"], { status: "final" }),
    ]);
    const df = buildDataFilter(a, "Observation", "s");
    expect(df.queryRestrictions).toEqual({ category: ["laboratory"], status: ["final"] });
  });
});
