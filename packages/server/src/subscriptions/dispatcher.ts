/**
 * Subscription dispatcher (Subscriptions R5 Backport IG) — the runtime that turns Bronze
 * writes into rest-hook notifications. Opt-in via FHIRENGINE_SUBSCRIPTIONS_ENABLED.
 *
 *  - Parses backport Subscription resources (topic in criteria; filter/payload/channel exts).
 *  - Handshake on activation: POST a handshake bundle → 2xx flips status requested→active
 *    (persisted back to the Subscription), non-2xx → error.
 *  - On each resource change, matches active subscriptions and POSTs an event-notification
 *    bundle with the configured payload content; per-subscription event counter increments.
 *  - Delivery is SSRF-guarded and fire-and-forget (never blocks or fails the triggering write).
 *
 * Single-node: state (active set, counters) is in-process. Multi-node fan-out is a documented
 * follow-up (mirrors the OAuth/rate-limit shared-store pattern).
 */
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { DeltaResourceRepository } from "../repository/delta-resource-repository.js";
import { assertPublicHttpUrl } from "../auth/udap/ssrf-guard.js";
import { logSwallowed, log } from "../lib/log.js";
import { subscriptionMatches, type ParsedSubscription } from "./matcher.js";
import { resolveTopic } from "./topics.js";
import { buildNotificationBundle, type NotificationEvent, type NotificationType } from "./notification.js";

const BACKPORT = "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition";

export const subscriptionsEnabled = (): boolean => process.env.FHIRENGINE_SUBSCRIPTIONS_ENABLED === "true";

type FetchImpl = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

function ext(exts: unknown, url: string): Record<string, unknown> | undefined {
  if (!Array.isArray(exts)) return undefined;
  return exts.find((e) => (e as { url?: string })?.url === url) as Record<string, unknown> | undefined;
}

/** Parse a backport Subscription resource; null if it isn't a usable rest-hook backport sub. */
export function parseSubscription(resource: Record<string, unknown>): ParsedSubscription | null {
  if (resource.resourceType !== "Subscription" || typeof resource.id !== "string") return null;
  const topicCanonical = typeof resource.criteria === "string" ? resource.criteria : "";
  if (!topicCanonical) return null;
  const channel = (resource.channel ?? {}) as Record<string, unknown>;
  if (channel.type !== "rest-hook") return null;
  const endpoint = typeof channel.endpoint === "string" ? channel.endpoint : "";
  if (!endpoint) return null;

  // filter-criteria: extensions on Subscription.criteria's primitive sibling (_criteria).
  const criteriaExts = (resource._criteria as { extension?: unknown[] } | undefined)?.extension;
  const filters: string[] = [];
  if (Array.isArray(criteriaExts)) {
    for (const e of criteriaExts) {
      const ee = e as { url?: string; valueString?: string };
      if (ee.url === `${BACKPORT}/backport-filter-criteria` && typeof ee.valueString === "string") filters.push(ee.valueString);
    }
  }

  const payload = (channel.payload ?? undefined) as string | undefined;
  const payloadExt = ext((channel._payload as { extension?: unknown[] } | undefined)?.extension, `${BACKPORT}/backport-payload-content`);
  const payloadContent = (payloadExt?.valueCode as string) ?? "id-only";
  const heartbeatExt = ext(channel.extension, `${BACKPORT}/backport-heartbeat-period`);

  return {
    id: resource.id,
    topicCanonical,
    filters,
    endpoint,
    payloadContent: payloadContent === "empty" || payloadContent === "full-resource" ? payloadContent : "id-only",
    mimeType: typeof payload === "string" && payload ? payload : "application/fhir+json",
    headers: Array.isArray(channel.header) ? (channel.header as string[]) : [],
    heartbeatPeriod: typeof heartbeatExt?.valueUnsignedInt === "number" ? heartbeatExt.valueUnsignedInt : null,
  };
}

export class SubscriptionDispatcher {
  private readonly active = new Map<string, ParsedSubscription>();
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly wh: DeltaWarehouse,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchImpl = (url, init) => fetch(url, init),
    private readonly ssrfCheck: (url: string) => Promise<void> = assertPublicHttpUrl,
  ) {}

  /** Load all `active` Subscriptions from the store into the active set (boot / refresh). */
  async loadActive(): Promise<number> {
    let subs: Array<Record<string, unknown>> = [];
    try {
      subs = (await new DeltaResourceRepository(this.wh, "Subscription")
        .searchByParams({ conds: [{ code: "status", type: "token", value: "active" }], count: 1000, offset: 0 }))
        .resources as unknown as Array<Record<string, unknown>>;
    } catch (e) { logSwallowed("subscriptions:load-active", e); return 0; }
    this.active.clear();
    for (const s of subs) {
      const parsed = parseSubscription(s);
      if (parsed) { this.active.set(parsed.id, parsed); if (!this.counters.has(parsed.id)) this.counters.set(parsed.id, 0); }
    }
    return this.active.size;
  }

  /** Handle a Subscription write: `requested` → handshake → active/error; `active` → track;
   *  `off`/`error`/deleted → drop from the active set. Called after a Subscription is stored. */
  async onSubscriptionChange(resource: Record<string, unknown>, deleted: boolean): Promise<void> {
    const parsed = parseSubscription(resource);
    if (!parsed) return;
    if (deleted || resource.status === "off" || resource.status === "error") {
      this.active.delete(parsed.id);
      return;
    }
    if (resource.status === "requested") {
      await this.handshake(parsed);
      return;
    }
    if (resource.status === "active") {
      this.active.set(parsed.id, parsed);
      if (!this.counters.has(parsed.id)) this.counters.set(parsed.id, 0);
    }
  }

  private async handshake(sub: ParsedSubscription): Promise<void> {
    const ok = await this.deliver(sub, "handshake", []);
    const nextStatus = ok ? "active" : "error";
    if (ok) { this.active.set(sub.id, sub); this.counters.set(sub.id, this.counters.get(sub.id) ?? 0); }
    await this.persistStatus(sub.id, nextStatus);
  }

  /** Fire notifications for a resource change across all matching active subscriptions. */
  async onResourceChange(resourceType: string, resource: Record<string, unknown>, interaction: "create" | "update" | "delete"): Promise<void> {
    if (resourceType === "Subscription") return; // handled by onSubscriptionChange
    for (const sub of this.active.values()) {
      if (!subscriptionMatches(sub, resourceType, interaction, resource)) continue;
      const n = (this.counters.get(sub.id) ?? 0) + 1;
      this.counters.set(sub.id, n);
      const event: NotificationEvent = {
        eventNumber: n,
        timestamp: (resource.meta as { lastUpdated?: string } | undefined)?.lastUpdated ?? new Date().toISOString(),
        focusReference: `${resourceType}/${resource.id}`,
        resource: sub.payloadContent === "full-resource" ? resource : undefined,
      };
      void this.deliver(sub, "event-notification", [event]); // fire-and-forget
    }
  }

  private async deliver(sub: ParsedSubscription, type: NotificationType, events: NotificationEvent[]): Promise<boolean> {
    try {
      await this.ssrfCheck(sub.endpoint); // SSRF guard: no loopback/RFC1918/metadata targets
    } catch (e) {
      logSwallowed(`subscriptions:ssrf:${sub.id}`, e);
      return false;
    }
    const bundle = buildNotificationBundle({
      baseUrl: this.baseUrl, subscriptionId: sub.id, type,
      status: type === "handshake" ? "requested" : "active",
      topicCanonical: sub.topicCanonical,
      eventsSinceStart: this.counters.get(sub.id) ?? 0,
      payloadContent: sub.payloadContent, events,
    });
    const headers: Record<string, string> = { "Content-Type": sub.mimeType };
    for (const h of sub.headers) { const i = h.indexOf(":"); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
    try {
      const res = await this.fetchImpl(sub.endpoint, { method: "POST", headers, body: JSON.stringify(bundle) });
      const ok = res.status >= 200 && res.status < 300;
      if (!ok) logSwallowed(`subscriptions:delivery:${sub.id}`, new Error(`endpoint returned ${res.status}`));
      return ok;
    } catch (e) {
      logSwallowed(`subscriptions:delivery:${sub.id}`, e);
      return false;
    }
  }

  private async persistStatus(id: string, status: "active" | "error"): Promise<void> {
    try {
      const repo = new DeltaResourceRepository(this.wh, "Subscription");
      const current = await repo.read(id);
      if ((current as { status?: string }).status === status) return;
      await repo.update(id, { ...current, status } as never, null);
    } catch (e) {
      logSwallowed(`subscriptions:persist-status:${id}`, e);
    }
  }

  /** Test/introspection: current active subscription ids + their event counters. */
  snapshot(): Array<{ id: string; events: number }> {
    return [...this.active.keys()].map((id) => ({ id, events: this.counters.get(id) ?? 0 }));
  }
  eventCount(id: string): number { return this.counters.get(id) ?? 0; }
  topicOf(id: string): string | undefined { const s = this.active.get(id); return s ? resolveTopic(s.topicCanonical)?.url : undefined; }
}

/** Process-wide dispatcher (set at boot when subscriptions are enabled). */
let dispatcher: SubscriptionDispatcher | null = null;
export function setDispatcher(d: SubscriptionDispatcher | null): void { dispatcher = d; }
export function getDispatcher(): SubscriptionDispatcher | null { return dispatcher; }

/** Emit hook called from the repository write path (fire-and-forget, never throws). */
export function emitResourceChange(resourceType: string, resource: Record<string, unknown>, interaction: "create" | "update" | "delete"): void {
  const d = dispatcher;
  if (!d) return;
  if (resourceType === "Subscription") {
    void d.onSubscriptionChange(resource, interaction === "delete").catch((e) => logSwallowed("subscriptions:emit-sub", e));
  } else {
    void d.onResourceChange(resourceType, resource, interaction).catch((e) => logSwallowed("subscriptions:emit", e));
  }
  void log; // reserved
}
