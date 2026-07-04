/**
 * Partial-expansion correctness (regression: US Core's `us-core-documentreference-type`
 * composes LOINC with a filter — not locally expandable — and the stored PARTIAL expansion
 * hard-rejected valid codes like 34133-9 as `invalid`. A membership miss against a partial
 * expansion proves nothing → 3-state must degrade to `unknown`).
 */
import { describe, it, expect } from "vitest";
import { expandValueSet } from "../../src/terminology/terminology-loader.js";
import { validateCode } from "../../src/terminology/validate-code.js";
import type { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";

const concepts = new Map([
  ["http://example.org/cs", [
    { system: "http://example.org/cs", code: "a", display: "A", version: null },
    { system: "http://example.org/cs", code: "b", display: "B", version: null },
  ]],
]);

describe("expandValueSet — completeness flag", () => {
  const vs = (compose: unknown) => ({ url: "http://example.org/vs", compose });

  it("enumerated concepts → complete", () => {
    const r = expandValueSet(vs({ include: [{ system: "http://x", concept: [{ code: "c1" }] }] }), concepts);
    expect(r.complete).toBe(true);
    expect(r.rows).toHaveLength(1);
  });

  it("whole loaded system → complete, all concepts", () => {
    const r = expandValueSet(vs({ include: [{ system: "http://example.org/cs" }] }), concepts);
    expect(r.complete).toBe(true);
    expect(r.rows.map((x) => x.code).sort()).toEqual(["a", "b"]);
  });

  it("filter include → INCOMPLETE and does NOT dump the whole system", () => {
    const r = expandValueSet(vs({ include: [{ system: "http://example.org/cs", filter: [{ property: "x", op: "=", value: "y" }] }] }), concepts);
    expect(r.complete).toBe(false);
    expect(r.rows).toHaveLength(0); // the filter restricts the system — dumping it all would over-include
  });

  it("unloaded external system → incomplete", () => {
    const r = expandValueSet(vs({ include: [{ system: "http://loinc.org" }] }), concepts);
    expect(r.complete).toBe(false);
  });

  it("valueSet import → incomplete", () => {
    const r = expandValueSet(vs({ include: [{ valueSet: ["http://example.org/other"] }] }), concepts);
    expect(r.complete).toBe(false);
  });

  it("exclude present → incomplete (excludes are not applied)", () => {
    const r = expandValueSet(vs({
      include: [{ system: "http://x", concept: [{ code: "c1" }] }],
      exclude: [{ system: "http://x", concept: [{ code: "c2" }] }],
    }), concepts);
    expect(r.complete).toBe(false);
  });
});

/** Stub warehouse: one VS with member 'in-set'; header completeness configurable. */
function stubWh(opts: { complete?: boolean; headerTable?: boolean }): DeltaWarehouse {
  return {
    registerTerminology() {},
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("FROM valueset_expansion")) {
        if (sql.includes("code = ?")) return params[1] === "in-set" ? [{ display: null }] : [];
        return [{ ok: 1 }]; // VS is loaded
      }
      if (sql.includes("FROM valueset_header")) {
        if (!opts.headerTable) throw new Error("table not found");
        return [{ complete: opts.complete }];
      }
      return [];
    },
  } as unknown as DeltaWarehouse;
}

describe("validateCode — 3-state with partial expansions", () => {
  const vs = "http://example.org/vs";

  it("member → valid regardless of completeness", async () => {
    expect((await validateCode(stubWh({ complete: false, headerTable: true }), { valueSet: vs, code: "in-set" })).status).toBe("valid");
  });

  it("miss against a PARTIAL expansion → unknown (never invalid)", async () => {
    const r = await validateCode(stubWh({ complete: false, headerTable: true }), { valueSet: vs, code: "34133-9" });
    expect(r.status).toBe("unknown");
    expect(r.message).toContain("partial");
  });

  it("miss against a COMPLETE expansion → invalid", async () => {
    expect((await validateCode(stubWh({ complete: true, headerTable: true }), { valueSet: vs, code: "nope" })).status).toBe("invalid");
  });

  it("legacy store without valueset_header → strict miss = invalid", async () => {
    expect((await validateCode(stubWh({ headerTable: false }), { valueSet: vs, code: "nope" })).status).toBe("invalid");
  });
});
