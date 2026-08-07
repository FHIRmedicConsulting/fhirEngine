import { describe, it, expect } from "vitest";
import { validateInvariants, type Invariant } from "../../src/validation/invariant-validator.js";

const inv = (path: string, key: string, expression: string): Invariant => ({ path, key, expression });

describe("validateInvariants — context depth", () => {
  it("top-level and one-level contexts still evaluate (pat-1 shape)", () => {
    const patient = {
      resourceType: "Patient", id: "p1",
      contact: [{ organization: { reference: "Organization/x" } }], // no name/telecom/address
    };
    const issues = validateInvariants(patient, [
      inv("Patient.contact", "pat-1", "name.exists() or telecom.exists() or address.exists() or organization.exists()"),
    ]);
    expect(issues).toEqual([]); // organization present → satisfied
    const bad = validateInvariants({ resourceType: "Patient", id: "p2", contact: [{ gender: "male" }] }, [
      inv("Patient.contact", "pat-1", "name.exists() or telecom.exists() or address.exists() or organization.exists()"),
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.message).toContain("pat-1");
  });

  it("depth-2 contexts are now evaluated (was: silently skipped)", () => {
    const q = {
      resourceType: "Questionnaire", id: "q1", status: "active",
      item: [{ linkId: "g", type: "group", item: [{ type: "string" }] }], // nested item missing linkId
    };
    const issues = validateInvariants(q, [inv("Questionnaire.item.item", "syn-1", "linkId.exists()")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("syn-1");
    const ok = validateInvariants(
      { resourceType: "Questionnaire", id: "q2", status: "active", item: [{ linkId: "g", item: [{ linkId: "a" }] }] },
      [inv("Questionnaire.item.item", "syn-1", "linkId.exists()")],
    );
    expect(ok).toEqual([]);
  });

  it("fans out across arrays at every level — one violating deep node is enough", () => {
    const q = {
      resourceType: "Questionnaire", id: "q3", status: "active",
      item: [
        { linkId: "g1", item: [{ linkId: "a" }, { linkId: "b" }] },
        { linkId: "g2", item: [{ type: "string" }] }, // violator in the second branch
      ],
    };
    expect(validateInvariants(q, [inv("Questionnaire.item.item", "syn-1", "linkId.exists()")])).toHaveLength(1);
  });

  it("`[x]` choice segments resolve to whichever choice property is present", () => {
    const obs = { resourceType: "Observation", id: "o1", status: "final", valueQuantity: { value: 5 } };
    // `false` always fails — proves the [x] node was actually found and evaluated.
    expect(validateInvariants(obs, [inv("Observation.value[x]", "syn-x", "false")])).toHaveLength(1);
    // No value[x] present → no nodes → no issue.
    expect(validateInvariants({ resourceType: "Observation", id: "o2", status: "final" },
      [inv("Observation.value[x]", "syn-x", "false")])).toEqual([]);
  });

  it("absent context paths prune silently (no false failures)", () => {
    expect(validateInvariants({ resourceType: "Patient", id: "p3" },
      [inv("Patient.contact.name", "syn-2", "false")])).toEqual([]);
  });
});
