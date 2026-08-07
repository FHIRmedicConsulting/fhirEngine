import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { configureTopics, resolveTopic, typeTopicUrl } from "../../src/subscriptions/topics.js";
import { subscriptionMatches, type ParsedSubscription } from "../../src/subscriptions/matcher.js";
import { buildNotificationBundle, STATUS_PROFILE } from "../../src/subscriptions/notification.js";
import { parseSubscription, SubscriptionDispatcher, emitResourceChange, setDispatcher } from "../../src/subscriptions/dispatcher.js";
import type { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";

const BASE = "https://fhir.example";
const BACKPORT = "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition";
const TOPIC = `${BASE}/SubscriptionTopic/Condition`;

const ENV = ["FHIRENGINE_SUBSCRIPTIONS_ENABLED", "FHIRENGINE_SUBSCRIPTION_TOPICS"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  configureTopics(BASE);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setDispatcher(null);
});

const sub = (over: Partial<ParsedSubscription> = {}): ParsedSubscription => ({
  id: "sub1", topicCanonical: TOPIC, filters: [], endpoint: "https://app.example/hook",
  payloadContent: "id-only", mimeType: "application/fhir+json", headers: [], heartbeatPeriod: null, ...over,
});
const condition = (over: Record<string, unknown> = {}) => ({
  resourceType: "Condition", id: "c1",
  code: { coding: [{ system: "http://snomed.info/sct", code: "38341003" }] },
  subject: { reference: "Patient/p1" }, meta: { lastUpdated: "2026-08-07T00:00:00Z" }, ...over,
});

describe("topics", () => {
  it("built-in per-type topic resolves; unknown canonical does not", () => {
    expect(resolveTopic(typeTopicUrl("Condition"))?.resourceTypes).toEqual(["Condition"]);
    expect(resolveTopic("https://other/Topic/x")).toBeNull();
  });
  it("operator topics from env override + support multi-type and interaction filters", () => {
    process.env.FHIRENGINE_SUBSCRIPTION_TOPICS = JSON.stringify([
      { url: "https://ex/topic/admit", resourceTypes: ["Encounter"], interactions: ["create"] }]);
    configureTopics(BASE);
    const t = resolveTopic("https://ex/topic/admit")!;
    expect(t.resourceTypes).toEqual(["Encounter"]);
    expect(t.interactions).toEqual(["create"]);
  });
});

describe("matcher", () => {
  it("matches a covered type/interaction with no filters", () => {
    expect(subscriptionMatches(sub(), "Condition", "create", condition())).toBe(true);
    expect(subscriptionMatches(sub(), "Observation", "create", condition())).toBe(false); // wrong type
  });
  it("token filter matches system|code and bare code, rejects mismatch", () => {
    expect(subscriptionMatches(sub({ filters: ["code=38341003"] }), "Condition", "update", condition())).toBe(true);
    expect(subscriptionMatches(sub({ filters: ["code=http://snomed.info/sct|38341003"] }), "Condition", "update", condition())).toBe(true);
    expect(subscriptionMatches(sub({ filters: ["code=99999999"] }), "Condition", "update", condition())).toBe(false);
  });
  it("reference filter matches bare id and full reference", () => {
    expect(subscriptionMatches(sub({ filters: ["patient=p1"] }), "Condition", "update", condition())).toBe(true);
    expect(subscriptionMatches(sub({ filters: ["patient=Patient/p1"] }), "Condition", "update", condition())).toBe(true);
    expect(subscriptionMatches(sub({ filters: ["patient=p2"] }), "Condition", "update", condition())).toBe(false);
  });
  it("ALL filters must match (AND)", () => {
    expect(subscriptionMatches(sub({ filters: ["code=38341003", "patient=p1"] }), "Condition", "update", condition())).toBe(true);
    expect(subscriptionMatches(sub({ filters: ["code=38341003", "patient=pX"] }), "Condition", "update", condition())).toBe(false);
  });
  it("unknown filter param fails closed", () => {
    expect(subscriptionMatches(sub({ filters: ["not-a-param=x"] }), "Condition", "update", condition())).toBe(false);
  });
  it("filtered subscriptions do not fire on delete (tombstone has no body); unfiltered do", () => {
    expect(subscriptionMatches(sub({ filters: ["code=38341003"] }), "Condition", "delete", condition())).toBe(false);
    expect(subscriptionMatches(sub(), "Condition", "delete", condition())).toBe(true);
  });
});

describe("notification bundle (backport shape)", () => {
  const args = {
    baseUrl: BASE, subscriptionId: "sub1", topicCanonical: TOPIC,
    eventsSinceStart: 1, payloadContent: "id-only" as const,
    events: [{ eventNumber: 1, timestamp: "2026-08-07T00:00:00Z", focusReference: "Condition/c1" }],
  };

  it("is a history Bundle whose first entry is a profiled SubscriptionStatus Parameters", () => {
    const b = buildNotificationBundle({ ...args, type: "event-notification", status: "active" }) as any;
    expect(b.type).toBe("history");
    const status = b.entry[0].resource;
    expect(status.resourceType).toBe("Parameters");
    expect(status.meta.profile).toEqual([STATUS_PROFILE]);
    const byName = (n: string) => status.parameter.find((p: any) => p.name === n);
    expect(byName("status").valueCode).toBe("active");
    expect(byName("type").valueCode).toBe("event-notification");
    expect(byName("topic").valueCanonical).toBe(TOPIC);
    const ev = status.parameter.find((p: any) => p.name === "notification-event");
    expect(ev.part.find((p: any) => p.name === "event-number").valueString).toBe("1");
    expect(ev.part.find((p: any) => p.name === "focus").valueReference.reference).toBe(`${BASE}/Condition/c1`);
  });

  it("EVERY entry carries entry.request (bdl-3/bdl-4)", () => {
    const b = buildNotificationBundle({ ...args, type: "event-notification", status: "active" }) as any;
    expect(b.entry.every((e: any) => e.request?.method && e.request?.url)).toBe(true);
  });

  it("id-only omits payload resources; full-resource includes them; empty adds no payload entry", () => {
    const withRes = { ...args.events[0], resource: { resourceType: "Condition", id: "c1" } };
    const idOnly = buildNotificationBundle({ ...args, type: "event-notification", status: "active" }) as any;
    expect(idOnly.entry).toHaveLength(2);
    expect(idOnly.entry[1].resource).toBeUndefined();
    expect(idOnly.entry[1].fullUrl).toBe(`${BASE}/Condition/c1`);
    const full = buildNotificationBundle({ ...args, type: "event-notification", status: "active", payloadContent: "full-resource", events: [withRes] }) as any;
    expect(full.entry[1].resource.id).toBe("c1");
    const empty = buildNotificationBundle({ ...args, type: "event-notification", status: "active", payloadContent: "empty" }) as any;
    expect(empty.entry).toHaveLength(1); // status only
  });

  it("handshake carries no payload entries", () => {
    const b = buildNotificationBundle({ ...args, type: "handshake", status: "requested", events: [] }) as any;
    expect(b.entry).toHaveLength(1);
    expect(b.entry[0].resource.parameter.find((p: any) => p.name === "type").valueCode).toBe("handshake");
  });
});

describe("parseSubscription (backport extension extraction)", () => {
  it("extracts topic, rest-hook endpoint, filters, payload content, heartbeat", () => {
    const resource = {
      resourceType: "Subscription", id: "s1", status: "active", criteria: TOPIC,
      _criteria: { extension: [{ url: `${BACKPORT}/backport-filter-criteria`, valueString: "patient=Patient/p1" }] },
      channel: {
        type: "rest-hook", endpoint: "https://app.example/hook", payload: "application/fhir+json",
        _payload: { extension: [{ url: `${BACKPORT}/backport-payload-content`, valueCode: "full-resource" }] },
        extension: [{ url: `${BACKPORT}/backport-heartbeat-period`, valueUnsignedInt: 60 }],
        header: ["Authorization: Bearer xyz"],
      },
    };
    const p = parseSubscription(resource)!;
    expect(p.topicCanonical).toBe(TOPIC);
    expect(p.filters).toEqual(["patient=Patient/p1"]);
    expect(p.payloadContent).toBe("full-resource");
    expect(p.heartbeatPeriod).toBe(60);
    expect(p.headers).toEqual(["Authorization: Bearer xyz"]);
  });
  it("rejects non-rest-hook / missing endpoint / missing topic", () => {
    expect(parseSubscription({ resourceType: "Subscription", id: "s", criteria: "t", channel: { type: "email", endpoint: "mailto:x" } })).toBeNull();
    expect(parseSubscription({ resourceType: "Subscription", id: "s", criteria: "t", channel: { type: "rest-hook" } })).toBeNull();
    expect(parseSubscription({ resourceType: "Subscription", id: "s", channel: { type: "rest-hook", endpoint: "https://x" } })).toBeNull();
  });
  it("defaults payload content to id-only when the extension is absent", () => {
    const p = parseSubscription({ resourceType: "Subscription", id: "s", criteria: "t", channel: { type: "rest-hook", endpoint: "https://app.example/h" } })!;
    expect(p.payloadContent).toBe("id-only");
  });
});

describe("dispatcher delivery (injected fetch, no real HTTP)", () => {
  function fakeWh(): { wh: DeltaWarehouse; updates: any[] } {
    const updates: any[] = [];
    const repoRead = { resourceType: "Subscription", id: "s1", status: "requested", criteria: TOPIC, channel: { type: "rest-hook", endpoint: "https://app.example/hook" } };
    const wh = {
      // DeltaResourceRepository(wh,...).read/update/searchByParams route through the warehouse;
      // stub just enough for persistStatus + read.
      serveTableReady: async () => true,
      query: async () => [{ body_json: JSON.stringify(repoRead), last_updated: "t" }],
    } as unknown as DeltaWarehouse;
    return { wh, updates };
  }

  const activeSub = (over: Partial<ParsedSubscription> = {}) => sub({ ...over });

  it("event-notification is delivered to matching active subscriptions with the right bundle", async () => {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const d = new SubscriptionDispatcher({} as DeltaWarehouse, BASE, async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { status: 200 };
    }, async () => {});
    // Seed an active subscription directly.
    (d as any).active.set("sub1", activeSub());
    (d as any).counters.set("sub1", 0);
    await d.onResourceChange("Condition", condition(), "update");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://app.example/hook");
    expect(calls[0]!.body.type).toBe("history");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/fhir+json");
    expect(d.eventCount("sub1")).toBe(1);
  });

  it("non-matching change delivers nothing", async () => {
    let n = 0;
    const d = new SubscriptionDispatcher({} as DeltaWarehouse, BASE, async () => { n++; return { status: 200 }; }, async () => {});
    (d as any).active.set("sub1", activeSub({ filters: ["patient=someone-else"] }));
    (d as any).counters.set("sub1", 0);
    await d.onResourceChange("Condition", condition(), "update");
    expect(n).toBe(0);
  });

  it("custom headers are split into request headers", async () => {
    let seen: Record<string, string> = {};
    const d = new SubscriptionDispatcher({} as DeltaWarehouse, BASE, async (_u, init) => { seen = init.headers; return { status: 200 }; }, async () => {});
    (d as any).active.set("sub1", activeSub({ headers: ["Authorization: Bearer abc", "X-Tenant: t1"] }));
    (d as any).counters.set("sub1", 0);
    await d.onResourceChange("Condition", condition(), "update");
    expect(seen.Authorization).toBe("Bearer abc");
    expect(seen["X-Tenant"]).toBe("t1");
  });

  it("SSRF guard blocks loopback/private endpoints (no delivery attempt)", async () => {
    let n = 0;
    const d = new SubscriptionDispatcher({} as DeltaWarehouse, BASE, async () => { n++; return { status: 200 }; });
    (d as any).active.set("sub1", activeSub({ endpoint: "http://127.0.0.1:9000/hook" }));
    (d as any).counters.set("sub1", 0);
    await d.onResourceChange("Condition", condition(), "update");
    expect(n).toBe(0); // fetch never called — blocked before delivery
  });

  it("emitResourceChange is a no-op when no dispatcher is set", () => {
    setDispatcher(null);
    expect(() => emitResourceChange("Condition", condition(), "create")).not.toThrow();
  });
});
