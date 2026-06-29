/**
 * Unit tests for `evaluateConsent` — point 5 of the five-point chain.
 *
 * Exhaustive matrix across:
 *   - Scope context: system | user | patient (own / other) | anonymous
 *   - HCS confidentiality: N (default) | R | V
 *   - HCS sensitivity tag: none | ETH | HIV
 *
 * The default policy under test is ADR-0018 §5.2:
 *   - system-context → always allow
 *   - patient-context where compartment id == launchPatient → always allow
 *   - patient-context where compartment id != launchPatient → deny
 *   - user-context with R/V confidentiality → deny
 *   - user-context with sensitivity tag → deny
 *   - anything else → deny
 */

import { describe, it, expect } from "vitest";
import {
  evaluateConsent,
  filterByConsent,
  compartmentPatientIdFor,
} from "../../../src/auth/consent-gate.js";
import type { AuthContext } from "../../../src/auth/auth-context.js";
import type { CanonicalScope } from "../../../src/auth/smart-versions/types.js";

const HCS_CONF = "http://terminology.hl7.org/CodeSystem/v3-Confidentiality";
const HCS_ACT = "http://terminology.hl7.org/CodeSystem/v3-ActCode";

function scope(context: "system" | "user" | "patient"): CanonicalScope {
  return {
    raw: `${context}/*.rs`,
    context,
    resource: "*",
    crud: { c: false, r: true, u: false, d: false, s: true },
    qualifiers: [],
  } as unknown as CanonicalScope;
}

function authFor(opts: {
  context: "system" | "user" | "patient" | "anonymous";
  launchPatientId?: string | null;
}): AuthContext {
  const ctx = opts.context;
  return {
    token: "test",
    subject: ctx === "anonymous" ? "anonymous" : `${ctx}-test`,
    clientId: "test-client",
    scopes: ctx === "anonymous" ? [] : [scope(ctx)],
    rawScopeString: ctx === "anonymous" ? "" : `${ctx}/*.rs`,
    launchPatientId: opts.launchPatientId ?? null,
    launchEncounterId: null,
    fhirUser: null,
    purposeOfUse: null,
    expiresAt: Date.now() / 1000 + 3600,
    issuer: "test",
    parsedUnderSmartVersion: "test",
  };
}

function labeledResource(
  resourceType: string,
  id: string,
  labels: Array<{ system: string; code: string }> = [],
) {
  return {
    resourceType,
    id,
    meta: { security: labels },
  };
}

describe("evaluateConsent — system-context", () => {
  const auth = authFor({ context: "system" });

  it("allows Normal confidentiality", () => {
    const r = labeledResource("Patient", "p1");
    expect(evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth }).allowed).toBe(true);
  });

  it("allows Restricted confidentiality (admin)", () => {
    const r = labeledResource("Patient", "p1", [{ system: HCS_CONF, code: "R" }]);
    expect(evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth }).allowed).toBe(true);
  });

  it("allows Very-Restricted confidentiality (admin)", () => {
    const r = labeledResource("Patient", "p1", [{ system: HCS_CONF, code: "V" }]);
    expect(evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth }).allowed).toBe(true);
  });

  it("allows sensitivity-tagged resources (admin overrides sensitivity)", () => {
    const r = labeledResource("Patient", "p1", [
      { system: HCS_CONF, code: "R" },
      { system: HCS_ACT, code: "ETH" },
    ]);
    expect(evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth }).allowed).toBe(true);
  });
});

describe("evaluateConsent — patient-context", () => {
  it("allows own compartment regardless of confidentiality", () => {
    const auth = authFor({ context: "patient", launchPatientId: "p1" });
    for (const code of ["N", "R", "V"] as const) {
      const r = labeledResource("Patient", "p1", [{ system: HCS_CONF, code }]);
      expect(
        evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth }).allowed,
      ).toBe(true);
    }
  });

  it("allows own compartment regardless of sensitivity tags (patient owns own data)", () => {
    const auth = authFor({ context: "patient", launchPatientId: "p1" });
    const r = labeledResource("Patient", "p1", [
      { system: HCS_ACT, code: "HIV" },
      { system: HCS_ACT, code: "ETH" },
    ]);
    expect(evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth }).allowed).toBe(true);
  });

  it("denies different patient's compartment", () => {
    const auth = authFor({ context: "patient", launchPatientId: "p1" });
    const r = labeledResource("Patient", "p2");
    const d = evaluateConsent({ resource: r, resourceCompartmentPatientId: "p2", auth });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/cannot read compartment/);
  });

  it("denies patient-context token missing launch/patient claim", () => {
    const auth = authFor({ context: "patient", launchPatientId: null });
    const r = labeledResource("Patient", "p1");
    const d = evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/without launch\/patient/);
  });
});

describe("evaluateConsent — user-context", () => {
  const auth = authFor({ context: "user" });

  it("allows Normal confidentiality, no sensitivity tags", () => {
    const r = labeledResource("Coverage", "c1");
    expect(evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth }).allowed).toBe(true);
  });

  it("denies Restricted confidentiality without explicit Consent", () => {
    const r = labeledResource("Coverage", "c1", [{ system: HCS_CONF, code: "R" }]);
    const d = evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/R-confidentiality/);
    expect(d.blockingLabels).toEqual(["R"]);
  });

  it("denies Very-Restricted confidentiality", () => {
    const r = labeledResource("Coverage", "c1", [{ system: HCS_CONF, code: "V" }]);
    const d = evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth });
    expect(d.allowed).toBe(false);
    expect(d.blockingLabels).toEqual(["V"]);
  });

  it("denies resource with sensitivity tag (ETH) even at Normal confidentiality", () => {
    const r = labeledResource("Coverage", "c1", [{ system: HCS_ACT, code: "ETH" }]);
    const d = evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/sensitive resource.*ETH/);
    expect(d.blockingLabels).toEqual(["ETH"]);
  });

  it("denies resource with multiple sensitivity tags (HIV + PSY)", () => {
    const r = labeledResource("Coverage", "c1", [
      { system: HCS_ACT, code: "HIV" },
      { system: HCS_ACT, code: "PSY" },
    ]);
    const d = evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth });
    expect(d.allowed).toBe(false);
    expect(d.blockingLabels).toEqual(["HIV", "PSY"]);
  });

  it("ignores non-HCS securityLabel codings", () => {
    // A code from a custom system that ISN'T HCS shouldn't trigger the gate.
    const r = labeledResource("Coverage", "c1", [
      { system: "http://example.org/custom-tags", code: "ETH" },
    ]);
    expect(evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth }).allowed).toBe(true);
  });
});

describe("evaluateConsent — anonymous / no scopes", () => {
  it("denies anonymous request defensively", () => {
    const auth = authFor({ context: "anonymous" });
    const r = labeledResource("Patient", "p1");
    const d = evaluateConsent({ resource: r, resourceCompartmentPatientId: "p1", auth });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/unauthenticated/);
  });
});

describe("filterByConsent", () => {
  const auth = authFor({ context: "user" });

  it("filters labeled resources and returns survivors + filtered list", () => {
    const a = labeledResource("Coverage", "ok-1");
    const b = labeledResource("Coverage", "blocked-1", [{ system: HCS_CONF, code: "R" }]);
    const c = labeledResource("Coverage", "ok-2");

    const { allowed, filtered } = filterByConsent(
      [a, b, c],
      () => "p1",
      auth,
    );
    expect(allowed.map((r) => r.id)).toEqual(["ok-1", "ok-2"]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.resource.id).toBe("blocked-1");
    expect(filtered[0]!.decision.blockingLabels).toEqual(["R"]);
  });

  it("bypasses gate when auth is undefined (test convenience)", () => {
    const r = labeledResource("Coverage", "c1", [{ system: HCS_CONF, code: "R" }]);
    const { allowed, filtered } = filterByConsent([r], () => "p1", undefined);
    expect(allowed).toHaveLength(1);
    expect(filtered).toHaveLength(0);
  });
});

describe("compartmentPatientIdFor", () => {
  it("Patient → patient id is itself", () => {
    expect(compartmentPatientIdFor({ resourceType: "Patient", id: "jane" })).toBe("jane");
  });

  it("Coverage → beneficiary reference", () => {
    expect(
      compartmentPatientIdFor({
        resourceType: "Coverage",
        id: "c1",
        // @ts-expect-error — GatedResource is the narrow shape; we add a beneficiary at runtime
        beneficiary: { reference: "Patient/jane" },
      }),
    ).toBe("jane");
  });

  it("ExplanationOfBenefit → patient reference", () => {
    expect(
      compartmentPatientIdFor({
        resourceType: "ExplanationOfBenefit",
        id: "e1",
        // @ts-expect-error — see above
        patient: { reference: "Patient/jane" },
      }),
    ).toBe("jane");
  });

  it("unknown resourceType → null", () => {
    expect(compartmentPatientIdFor({ resourceType: "Practitioner", id: "p1" })).toBe(null);
  });
});
