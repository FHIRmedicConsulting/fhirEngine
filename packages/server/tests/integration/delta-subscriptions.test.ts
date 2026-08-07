/**
 * Topic-based subscriptions end-to-end (Subscriptions R5 Backport IG): a stored active
 * Subscription's rest-hook fires when a matching resource is written — the full write →
 * match → notification-bundle chain over real delta-rs. Delivery is captured via an injected
 * dispatcher (no outbound HTTP). Gated on sidecar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { SubscriptionDispatcher, setDispatcher } from "../../src/subscriptions/dispatcher.js";
import { configureTopics, typeTopicUrl } from "../../src/subscriptions/topics.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const ts = Date.now();
const BASE = `${process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test"}-subs-${ts}`;
const PUBLIC = "https://fhir.example";
const BACKPORT = "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition";

describe.skipIf(!SIDECAR)("topic-based subscriptions e2e", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  let app: ReturnType<typeof createDeltaApp>;
  const deliveries: Array<{ url: string; body: any }> = [];
  let subId = "";
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    process.env.FHIRENGINE_SUBSCRIPTIONS_ENABLED = "true";
    configureTopics(PUBLIC);
    // Inject a capturing dispatcher (records deliveries, always 2xx, SSRF disabled for the test host).
    const dispatcher = new SubscriptionDispatcher(wh, PUBLIC,
      async (url, init) => { deliveries.push({ url, body: JSON.parse(init.body) }); return { status: 200 }; },
      async () => {});
    setDispatcher(dispatcher);
    app = createDeltaApp({ warehouse: wh, baseUrl: PUBLIC });

    // Create an ACTIVE subscription on the Condition topic filtered to patient p1, full-resource.
    // POST (not PUT-create — that 404s on an unprovisioned table; Run-14 finding); capture the id.
    const created = await (await req("POST", "/Subscription", {
      resourceType: "Subscription", status: "active", reason: "e2e test subscription",
      criteria: typeTopicUrl("Condition"),
      _criteria: { extension: [{ url: `${BACKPORT}/backport-filter-criteria`, valueString: `patient=Patient/pat${ts}` }] },
      channel: {
        type: "rest-hook", endpoint: "https://app.example/hook", payload: "application/fhir+json",
        _payload: { extension: [{ url: `${BACKPORT}/backport-payload-content`, valueCode: "full-resource" }] },
      },
    })).json();
    subId = created.id;
    await dispatcher.loadActive();
  });
  afterAll(() => { delete process.env.FHIRENGINE_SUBSCRIPTIONS_ENABLED; setDispatcher(null); });

  it("loads the active subscription", () => {
    expect(deliveries.length).toBe(0); // nothing fired yet
  });

  it("fires a full-resource notification when a matching Condition is created", async () => {
    await req("POST", "/Condition", {
      resourceType: "Condition", id: `cond${ts}`,
      code: { coding: [{ system: "http://snomed.info/sct", code: "38341003" }] },
      subject: { reference: `Patient/pat${ts}` },
    });
    // give the fire-and-forget emit a tick
    await new Promise((r) => setTimeout(r, 100));
    expect(deliveries.length).toBe(1);
    const d = deliveries[0]!;
    expect(d.url).toBe("https://app.example/hook");
    expect(d.body.type).toBe("history");
    const status = d.body.entry[0].resource;
    expect(status.resourceType).toBe("Parameters");
    expect(status.parameter.find((p: any) => p.name === "type").valueCode).toBe("event-notification");
    // full-resource payload entry present
    expect(d.body.entry[1].resource.resourceType).toBe("Condition");
    expect(d.body.entry[1].resource.id).toBe(`cond${ts}`);
  });

  it("does NOT fire for a non-matching patient", async () => {
    const before = deliveries.length;
    await req("POST", "/Condition", {
      resourceType: "Condition", id: `other${ts}`,
      code: { coding: [{ system: "http://snomed.info/sct", code: "38341003" }] },
      subject: { reference: "Patient/someone-else" },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(deliveries.length).toBe(before);
  });

  it("does NOT fire for a different resource type on the Condition topic", async () => {
    const before = deliveries.length;
    await req("POST", "/Observation", {
      resourceType: "Observation", id: `obs${ts}`, status: "final",
      code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
      subject: { reference: `Patient/pat${ts}` },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(deliveries.length).toBe(before);
  });

  it("$status returns the subscription's current status + event count", async () => {
    const b = await (await req("GET", `/Subscription/${subId}/$status`)).json();
    expect(b.resourceType).toBe("Bundle");
    const status = b.entry[0].resource;
    expect(status.parameter.find((p: any) => p.name === "status").valueCode).toBe("active");
    expect(Number(status.parameter.find((p: any) => p.name === "events-since-subscription-start").valueString)).toBeGreaterThanOrEqual(1);
  });

  it("increments the event counter across multiple matching writes", async () => {
    const before = deliveries.length;
    await req("PUT", `/Condition/cond${ts}`, {
      resourceType: "Condition", id: `cond${ts}`,
      code: { coding: [{ system: "http://snomed.info/sct", code: "38341003" }] },
      subject: { reference: `Patient/pat${ts}` },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(deliveries.length).toBe(before + 1);
    const lastEvent = deliveries[deliveries.length - 1]!.body.entry[0].resource
      .parameter.find((p: any) => p.name === "notification-event");
    expect(Number(lastEvent.part.find((p: any) => p.name === "event-number").valueString)).toBeGreaterThanOrEqual(2);
  });
});
