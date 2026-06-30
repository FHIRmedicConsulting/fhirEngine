/**
 * Choice-type (`[x]`) required-element presence (regression: Inferno US Core surfaced that
 * `medication[x]` was never satisfied by the concrete `medicationCodeableConcept`, false-
 * rejecting valid Synthea/US Core resources).
 */
import { describe, it, expect } from "vitest";
import { elementPresent } from "../../../src/validation/validation-chain.js";

describe("elementPresent — choice-type [x] expansion", () => {
  it("a concrete choice form satisfies a required foo[x] element", () => {
    expect(elementPresent({ medicationCodeableConcept: { text: "x" } }, "medication[x]")).toBe(true);
    expect(elementPresent({ medicationReference: { reference: "Medication/1" } }, "medication[x]")).toBe(true);
    expect(elementPresent({ valueQuantity: { value: 1 } }, "value[x]")).toBe(true);
  });

  it("a missing choice element is reported absent", () => {
    expect(elementPresent({ code: { text: "x" } }, "medication[x]")).toBe(false);
    expect(elementPresent({ medicationCodeableConcept: null }, "medication[x]")).toBe(false);
  });

  it("does not mistake a lowercase-suffixed key for a choice form", () => {
    // `medicationorder` is not a valid choice form of medication[x] (suffix must be Capitalized)
    expect(elementPresent({ medicationorder: "x" }, "medication[x]")).toBe(false);
  });

  it("plain (non-choice) required elements still checked for non-empty", () => {
    expect(elementPresent({ status: "active" }, "status")).toBe(true);
    expect(elementPresent({ status: "" }, "status")).toBe(false);
    expect(elementPresent({ identifier: [] }, "identifier")).toBe(false);
    expect(elementPresent({ identifier: [{ value: "1" }] }, "identifier")).toBe(true);
  });
});
