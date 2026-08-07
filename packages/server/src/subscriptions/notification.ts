/**
 * Backport notification bundle builder (Subscriptions R5 Backport IG,
 * profile `backport-subscription-notification-r4`).
 *
 * Shape:
 *   Bundle.type = history; EVERY entry carries entry.request (bdl-3/bdl-4).
 *   entry[0].resource = Parameters (profile `backport-subscription-status-r4`):
 *     subscription (Reference 1..1), status (code 1..1), type (code 1..1),
 *     topic (canonical 0..1), events-since-subscription-start (string 0..1),
 *     notification-event (0..*: event-number, timestamp, focus, additional-context),
 *   Payload entries (event-notification only): none for `empty`; fullUrl+request for
 *   `id-only`; + resource for `full-resource`.
 */
export const BACKPORT = "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition";
export const STATUS_PROFILE = `${BACKPORT}/backport-subscription-status-r4`;
export const NOTIFICATION_PROFILE = `${BACKPORT}/backport-subscription-notification-r4`;

export type NotificationType = "handshake" | "heartbeat" | "event-notification";

export interface NotificationEvent {
  eventNumber: number;
  timestamp: string;
  focusReference: string; // e.g. "Condition/123"
  resource?: Record<string, unknown>; // full-resource payload only
}

export interface BuildNotificationArgs {
  baseUrl: string;
  subscriptionId: string;
  type: NotificationType;
  status: "requested" | "active" | "error" | "off";
  topicCanonical: string;
  eventsSinceStart: number;
  payloadContent: "empty" | "id-only" | "full-resource";
  events: NotificationEvent[]; // empty for handshake/heartbeat
}

/** The SubscriptionStatus Parameters resource (entry[0]). */
function statusParameters(a: BuildNotificationArgs): Record<string, unknown> {
  const parameter: Array<Record<string, unknown>> = [
    { name: "subscription", valueReference: { reference: `${a.baseUrl}/Subscription/${a.subscriptionId}` } },
    { name: "topic", valueCanonical: a.topicCanonical },
    { name: "status", valueCode: a.status },
    { name: "type", valueCode: a.type },
    { name: "events-since-subscription-start", valueString: String(a.eventsSinceStart) },
  ];
  for (const e of a.events) {
    parameter.push({
      name: "notification-event",
      part: [
        { name: "event-number", valueString: String(e.eventNumber) },
        { name: "timestamp", valueInstant: e.timestamp },
        { name: "focus", valueReference: { reference: `${a.baseUrl}/${e.focusReference}` } },
      ],
    });
  }
  return { resourceType: "Parameters", meta: { profile: [STATUS_PROFILE] }, parameter };
}

export function buildNotificationBundle(a: BuildNotificationArgs): Record<string, unknown> {
  const entries: Array<Record<string, unknown>> = [
    {
      // The status resource has no persistent identity; its request is the $status query.
      fullUrl: `urn:uuid:status-${a.subscriptionId}`,
      resource: statusParameters(a),
      request: { method: "GET", url: `Subscription/${a.subscriptionId}/$status` },
    },
  ];

  if (a.type === "event-notification" && a.payloadContent !== "empty") {
    for (const e of a.events) {
      const entry: Record<string, unknown> = {
        fullUrl: `${a.baseUrl}/${e.focusReference}`,
        request: { method: "PUT", url: e.focusReference },
      };
      if (a.payloadContent === "full-resource" && e.resource) entry.resource = e.resource;
      entries.push(entry);
    }
  }

  return {
    resourceType: "Bundle",
    type: "history",
    timestamp: a.events[0]?.timestamp ?? new Date().toISOString(),
    entry: entries,
  };
}
