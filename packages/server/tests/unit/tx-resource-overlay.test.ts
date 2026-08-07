/** tx-resource overlay — client-supplied terminology (CodeSystemAsParameter):
 * in-memory CodeSystem/ValueSet evaluation, compose filters, cache-id sessions,
 * and the terminology routes consulting the overlay before the Delta store. */
import { describe, it, expect } from "vitest";
import { TxOverlay, overlayFor } from "../../src/terminology/tx-resource-overlay.js";
import { terminologyRoutes } from "../../src/routes/terminology.js";

const CS = {
  resourceType: "CodeSystem",
  url: "http://example.org/test/cs",
  version: "0.1.0",
  content: "complete",
  concept: [
    { code: "parent", display: "Parent", property: [{ code: "notSelectable", valueBoolean: true }],
      concept: [
        { code: "child1", display: "Child One" },
        { code: "child2", display: "Child Two",
          concept: [{ code: "grandchild", display: "Grandchild" }] },
      ] },
    { code: "retired1", display: "Retired", property: [{ code: "status", valueCode: "retired" }] },
    { code: "other", display: "Other" },
  ],
};
const VS_ALL = {
  resourceType: "ValueSet",
  url: "http://example.org/test/vs-all",
  version: "1.0.0",
  status: "active",
  compose: { include: [{ system: CS.url }] },
};
const VS_ENUM = {
  resourceType: "ValueSet",
  url: "http://example.org/test/vs-enum",
  compose: { include: [{ system: CS.url, concept: [{ code: "child1" }, { code: "other", display: "Overridden" }] }] },
};
const VS_ISA = {
  resourceType: "ValueSet",
  url: "http://example.org/test/vs-isa",
  compose: { include: [{ system: CS.url, filter: [{ property: "concept", op: "is-a", value: "parent" }] }] },
};
const VS_EXCLUDE = {
  resourceType: "ValueSet",
  url: "http://example.org/test/vs-exclude",
  compose: {
    include: [{ system: CS.url }],
    exclude: [{ system: CS.url, concept: [{ code: "other" }] }],
  },
};

function loaded(): TxOverlay {
  const o = new TxOverlay();
  for (const r of [CS, VS_ALL, VS_ENUM, VS_ISA, VS_EXCLUDE]) o.register(r);
  return o;
}

describe("TxOverlay expansion", () => {
  it("expands include-all with abstract/inactive flags, total, and used-codesystem", () => {
    const r = loaded().expand(VS_ALL, {});
    expect(r.valueSet.expansion.total).toBe(6);
    const byCode = Object.fromEntries(r.valueSet.expansion.contains.map((c: any) => [c.code, c]));
    expect(byCode.parent.abstract).toBe(true);
    expect(byCode.retired1.inactive).toBe(true);
    expect(byCode.grandchild.display).toBe("Grandchild");
    const used = r.valueSet.expansion.parameter.find((p: any) => p.name === "used-codesystem");
    expect(used.valueUri).toBe(`${CS.url}|0.1.0`);
    expect(r.valueSet.url).toBe(VS_ALL.url); // echoes the source ValueSet
  });

  it("enumerated include keeps order and display overrides", () => {
    const r = loaded().expand(VS_ENUM, {});
    expect(r.valueSet.expansion.contains.map((c: any) => c.code)).toEqual(["child1", "other"]);
    expect(r.valueSet.expansion.contains[1].display).toBe("Overridden");
  });

  it("is-a filter selects self + descendants; exclude subtracts; activeOnly drops inactive", () => {
    const overlay = loaded();
    const isa = overlay.expand(VS_ISA, {});
    expect(isa.valueSet.expansion.contains.map((c: any) => c.code).sort()).toEqual(
      ["child1", "child2", "grandchild", "parent"],
    );
    const excl = overlay.expand(VS_EXCLUDE, {});
    expect(excl.valueSet.expansion.contains.map((c: any) => c.code)).not.toContain("other");
    const active = overlay.expand(VS_ALL, { activeOnly: true });
    expect(active.valueSet.expansion.contains.map((c: any) => c.code)).not.toContain("retired1");
  });

  it("pages with count/offset while total stays the full count", () => {
    const r = loaded().expand(VS_ALL, { count: 2, offset: 2 });
    expect(r.valueSet.expansion.total).toBe(6);
    expect(r.valueSet.expansion.contains.length).toBe(2);
    expect(r.valueSet.expansion.offset).toBe(2);
  });

  it("cannot expand a ValueSet over a system it was not given", () => {
    const overlay = new TxOverlay();
    overlay.register(VS_ALL); // no CodeSystem supplied
    expect(overlay.expand(VS_ALL, {}).error).toContain("cannot be expanded");
  });

  it("circular ValueSet imports error instead of recursing forever (big-circle)", () => {
    const a = { resourceType: "ValueSet", url: "http://example.org/test/vs-a",
      compose: { include: [{ valueSet: ["http://example.org/test/vs-b"] }] } };
    const b = { resourceType: "ValueSet", url: "http://example.org/test/vs-b",
      compose: { include: [{ valueSet: ["http://example.org/test/vs-a"] }] } };
    const overlay = new TxOverlay();
    overlay.register(a); overlay.register(b); overlay.register(CS);
    expect(overlay.expand(a, {}).error).toContain("cannot be expanded");
    expect(overlay.validate(a.url, { system: CS.url, code: "child1" })).toBeNull();
  });

  it("diamond imports (shared non-circular dependency) still expand", () => {
    const d = { resourceType: "ValueSet", url: "http://example.org/test/vs-d",
      compose: { include: [{ system: CS.url, concept: [{ code: "other" }] }] } };
    const top = { resourceType: "ValueSet", url: "http://example.org/test/vs-top",
      compose: { include: [
        { valueSet: ["http://example.org/test/vs-d"] },
        { valueSet: ["http://example.org/test/vs-d"] },
      ] } };
    const overlay = loaded();
    overlay.register(d); overlay.register(top);
    const r = overlay.expand(top, {});
    expect(r.valueSet.expansion.total).toBe(1);
  });
});

describe("TxOverlay validation", () => {
  it("valid code in VS: display + version from the supplied CodeSystem", () => {
    const r = loaded().validate(VS_ALL.url, { system: CS.url, code: "child1" });
    expect(r).toMatchObject({ status: "valid", display: "Child One", version: "0.1.0" });
  });

  it("unknown code in a known system: invalid-code (not merely not-in-vs)", () => {
    const r = loaded().validate(VS_ALL.url, { system: CS.url, code: "nope" });
    expect(r?.status).toBe("invalid-code");
  });

  it("known code outside the VS: not-in-vs", () => {
    const r = loaded().validate(VS_ENUM.url, { system: CS.url, code: "grandchild" });
    expect(r?.status).toBe("not-in-vs");
  });

  it("returns null (fall back to store) for a VS the overlay does not know", () => {
    expect(loaded().validate("http://example.org/unknown", { system: CS.url, code: "child1" })).toBeNull();
  });
});

describe("cache-id sessions", () => {
  it("resources sent once are available on later calls that omit them", () => {
    const id = `session-${Date.now()}`;
    overlayFor(id, [CS, VS_ALL]);
    const later = overlayFor(id, []);
    expect(later.validate(VS_ALL.url, { system: CS.url, code: "child1" })?.status).toBe("valid");
  });

  it("no cache-id → request-scoped only", () => {
    overlayFor(undefined, [CS, VS_ALL]);
    expect(overlayFor(undefined, []).empty).toBe(true);
  });
});

describe("terminology routes with tx-resource (no Delta store needed)", () => {
  // Overlay paths never touch the warehouse — a stub proves it.
  const app = terminologyRoutes({} as any);
  const post = async (path: string, parameter: any[]) => {
    const res = await app.fetch(new Request(`http://test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json" },
      body: JSON.stringify({ resourceType: "Parameters", parameter }),
    }));
    return { status: res.status, body: await res.json() };
  };
  const val = (params: any[], name: string) => params.find((x: any) => x.name === name);

  it("$validate-code answers from tx-resources", async () => {
    const { status, body } = await post("/ValueSet/$validate-code", [
      { name: "url", valueUri: VS_ALL.url },
      { name: "code", valueCode: "child1" },
      { name: "system", valueUri: CS.url },
      { name: "tx-resource", resource: CS },
      { name: "tx-resource", resource: VS_ALL },
    ]);
    expect(status).toBe(200);
    expect(val(body.parameter, "result").valueBoolean).toBe(true);
    expect(val(body.parameter, "display").valueString).toBe("Child One");
    expect(val(body.parameter, "version").valueString).toBe("0.1.0");
  });

  it("$validate-code failure carries tx-issue-type coded issues", async () => {
    const { body } = await post("/ValueSet/$validate-code", [
      { name: "url", valueUri: VS_ALL.url },
      { name: "code", valueCode: "nope" },
      { name: "system", valueUri: CS.url },
      { name: "tx-resource", resource: CS },
      { name: "tx-resource", resource: VS_ALL },
    ]);
    expect(val(body.parameter, "result").valueBoolean).toBe(false);
    const issue = val(body.parameter, "issues").resource.issue[0];
    expect(issue.details.coding[0].system).toBe("http://hl7.org/fhir/tools/CodeSystem/tx-issue-type");
    expect(issue.details.coding[0].code).toBe("invalid-code");
  });

  it("$expand answers from tx-resources", async () => {
    const { body } = await post("/ValueSet/$expand", [
      { name: "url", valueUri: VS_ALL.url },
      { name: "tx-resource", resource: CS },
      { name: "tx-resource", resource: VS_ALL },
    ]);
    expect(body.resourceType).toBe("ValueSet");
    expect(body.expansion.total).toBe(6);
  });

  it("cache-id lets the client omit resources on later calls", async () => {
    const cacheId = `route-session-${Date.now()}`;
    await post("/ValueSet/$expand", [
      { name: "cache-id", valueId: cacheId },
      { name: "url", valueUri: VS_ALL.url },
      { name: "tx-resource", resource: CS },
      { name: "tx-resource", resource: VS_ALL },
    ]);
    const { body } = await post("/ValueSet/$validate-code", [
      { name: "cache-id", valueId: cacheId },
      { name: "url", valueUri: VS_ALL.url },
      { name: "code", valueCode: "grandchild" },
      { name: "system", valueUri: CS.url },
    ]);
    expect(val(body.parameter, "result").valueBoolean).toBe(true);
  });
});
