import { describe, it, expect } from "vitest";
import { jaroWinkler, scorePair, extractDemographics, blockingKeys, probabilisticCandidates } from "../../src/repository/mpi-probabilistic.js";

const patient = (over: Record<string, unknown> = {}) => ({
  resourceType: "Patient", id: "p1",
  name: [{ family: "Rivera", given: ["Ana"] }],
  birthDate: "1987-04-12", gender: "female",
  address: [{ postalCode: "94110" }],
  telecom: [{ system: "phone", value: "555-0100" }],
  ...over,
});

describe("jaroWinkler", () => {
  it("is 1 for identical, 0 for empty, and high for near-typos", () => {
    expect(jaroWinkler("martha", "martha")).toBe(1);
    expect(jaroWinkler("", "x")).toBe(0);
    expect(jaroWinkler("martha", "marhta")).toBeGreaterThan(0.9); // transposition
    expect(jaroWinkler("dwayne", "duane")).toBeGreaterThan(0.8);
    expect(jaroWinkler("rivera", "smith")).toBeLessThan(0.6);
  });
  it("rewards a shared prefix (Winkler boost)", () => {
    expect(jaroWinkler("jonathon", "jonathan")).toBeGreaterThan(jaroWinkler("nothanjo", "nathanjo"));
  });
});

describe("extractDemographics", () => {
  it("normalizes name/dob/gender/postal and digit-only phones", () => {
    const d = extractDemographics(patient());
    expect(d).toMatchObject({ family: "rivera", given: "ana", birthDate: "1987-04-12", gender: "female", postalCode: "94110" });
    expect(d.phones).toEqual(["5550100"]);
  });
});

describe("scorePair", () => {
  it("identical demographics → certain, high probability", () => {
    const s = scorePair(patient(), patient({ id: "p2" }));
    expect(s.grade).toBe("certain");
    expect(s.probability).toBeGreaterThan(0.99);
  });

  it("same person, typo'd name + missing MRN still grades probable/certain", () => {
    const s = scorePair(patient(), patient({ id: "p2", name: [{ family: "Riviera", given: ["Ana"] }] })); // JW 0.967 near
    expect(["certain", "probable"]).toContain(s.grade);
    const fam = s.comparisons.find((c) => c.name === "family")!;
    expect(fam.state).toBe("near"); // Jaro-Winkler near match, partial weight
  });

  it("different people → certainly-not", () => {
    const s = scorePair(patient(), patient({
      id: "p2", name: [{ family: "Okafor", given: ["Chidi"] }],
      birthDate: "1962-11-30", gender: "male", address: [{ postalCode: "10001" }],
      telecom: [{ system: "phone", value: "555-9999" }],
    }));
    expect(s.grade).toBe("certainly-not");
    expect(s.weight).toBeLessThan(0);
  });

  it("is symmetric (order-independent)", () => {
    const a = patient(), b = patient({ id: "p2", name: [{ family: "Rivara", given: ["Anna"] }] });
    expect(scorePair(a, b).weight).toBeCloseTo(scorePair(b, a).weight, 6);
  });

  it("a shared strong identifier field (phone) lifts weight; birthDate near = same year-month", () => {
    const s = scorePair(patient(), patient({ id: "p2", birthDate: "1987-04-28" }));
    const bd = s.comparisons.find((c) => c.name === "birthDate")!;
    expect(bd.state).toBe("near");
    const phone = s.comparisons.find((c) => c.name === "phone")!;
    expect(phone.state).toBe("agree");
  });

  it("missing fields contribute zero (not penalized)", () => {
    const s = scorePair(patient({ address: [], telecom: [] }), patient({ id: "p2", address: [], telecom: [] }));
    expect(s.comparisons.find((c) => c.name === "postalCode")!.state).toBe("missing");
    expect(s.comparisons.find((c) => c.name === "phone")!.state).toBe("missing");
    // family+given+dob+gender still agree → certain
    expect(s.grade).toBe("certain");
  });

  it("thresholds are env-tunable", () => {
    const saved = process.env.FHIRENGINE_MPI_THRESHOLD_CERTAIN;
    process.env.FHIRENGINE_MPI_THRESHOLD_CERTAIN = "999"; // unreachable → never 'certain'
    try {
      expect(scorePair(patient(), patient({ id: "p2" })).grade).not.toBe("certain");
    } finally {
      if (saved === undefined) delete process.env.FHIRENGINE_MPI_THRESHOLD_CERTAIN;
      else process.env.FHIRENGINE_MPI_THRESHOLD_CERTAIN = saved;
    }
  });
});

describe("blockingKeys", () => {
  it("emits family+birth-year, family+given-initial, dob+postal, phone blocks", () => {
    const keys = blockingKeys(patient());
    expect(keys).toContain("fam-yob:rivera:1987");
    expect(keys).toContain("fam-gin:rivera:a");
    expect(keys).toContain("dob-zip:1987-04-12:94110");
    expect(keys).toContain("phone:5550100");
  });
  it("two records of the same person share ≥1 block; unrelated share none", () => {
    const a = new Set(blockingKeys(patient()));
    const sameTypo = blockingKeys(patient({ name: [{ family: "Rivera", given: ["Ana"] }], telecom: [{ system: "phone", value: "555-0100" }] }));
    expect(sameTypo.some((k) => a.has(k))).toBe(true);
    const unrelated = blockingKeys(patient({ name: [{ family: "Okafor", given: ["Chidi"] }], birthDate: "1962-11-30", address: [{ postalCode: "10001" }], telecom: [] }));
    expect(unrelated.some((k) => a.has(k))).toBe(false);
  });
});

describe("probabilisticCandidates (promotion review feed)", () => {
  const rows = [
    { id: "a", body: { resourceType: "Patient", name: [{ family: "Rivera", given: ["Ana"] }], birthDate: "1987-04-12", gender: "female", address: [{ postalCode: "94110" }], telecom: [{ system: "phone", value: "555-0100" }] } },
    { id: "b", body: { resourceType: "Patient", name: [{ family: "Riviera", given: ["Ana"] }], birthDate: "1987-04-12", gender: "female", address: [{ postalCode: "94110" }] } }, // same person, typo, no MRN
    { id: "c", body: { resourceType: "Patient", name: [{ family: "Okafor", given: ["Chidi"] }], birthDate: "1962-11-30", gender: "male" } }, // unrelated
  ];

  it("surfaces the probable/certain no-shared-id pair, excludes the unrelated one", () => {
    const pairs = probabilisticCandidates(rows, new Set());
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.ids.sort()).toEqual(["a", "b"]);
    expect(["probable", "certain"]).toContain(pairs[0]!.grade);
  });

  it("skips pairs the deterministic stage already linked", () => {
    const pairs = probabilisticCandidates(rows, new Set(["a~b"]));
    expect(pairs).toHaveLength(0);
  });

  it("ignores inactive (merged-away) records", () => {
    const withInactive = [...rows, { id: "d", body: { ...rows[1]!.body, active: false } }];
    const pairs = probabilisticCandidates(withInactive, new Set());
    expect(pairs.every((p) => !p.ids.includes("d"))).toBe(true);
  });
});
