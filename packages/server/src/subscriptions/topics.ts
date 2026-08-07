/**
 * SubscriptionTopic registry (FHIR Subscriptions R5 Backport IG).
 *
 * A backport `Subscription.criteria` is a **SubscriptionTopic canonical URL** (not a search
 * string). A topic here maps a canonical → the resource type(s) whose changes trigger it and
 * which interactions (create/update/delete) fire.
 *
 * Built-in: one generic per-resource-type topic `<baseUrl>/SubscriptionTopic/<ResourceType>`
 * firing on any change to that type — the pragmatic default that makes "notify me when a
 * Condition changes" work with no server config. Operators add named clinical topics via
 * `FHIRENGINE_SUBSCRIPTION_TOPICS` (JSON: [{url, resourceTypes[], interactions?[]}]).
 */

export interface SubscriptionTopicDef {
  url: string;
  resourceTypes: string[]; // '*' allowed
  interactions: Array<"create" | "update" | "delete">;
}

const ALL_INTERACTIONS: Array<"create" | "update" | "delete"> = ["create", "update", "delete"];

let operatorTopics: SubscriptionTopicDef[] = [];
let baseUrl = "";

/** The built-in per-type topic canonical for a resource type. */
export function typeTopicUrl(resourceType: string): string {
  return `${baseUrl}/SubscriptionTopic/${resourceType}`;
}

export function configureTopics(base: string): void {
  baseUrl = base.replace(/\/$/, "");
  operatorTopics = [];
  const raw = process.env.FHIRENGINE_SUBSCRIPTION_TOPICS;
  if (raw) {
    try {
      const arr = JSON.parse(raw) as Array<{ url: string; resourceTypes: string[]; interactions?: string[] }>;
      for (const t of arr) {
        if (!t.url || !Array.isArray(t.resourceTypes)) continue;
        operatorTopics.push({
          url: t.url,
          resourceTypes: t.resourceTypes,
          interactions: (t.interactions?.length ? t.interactions : ALL_INTERACTIONS) as SubscriptionTopicDef["interactions"],
        });
      }
    } catch { /* malformed → built-in topics only */ }
  }
}

/** Resolve a topic canonical to its definition (operator topics first, then the built-in
 * per-type pattern). Null when the server does not support the topic. */
export function resolveTopic(canonical: string): SubscriptionTopicDef | null {
  const op = operatorTopics.find((t) => t.url === canonical);
  if (op) return op;
  const prefix = `${baseUrl}/SubscriptionTopic/`;
  if (canonical.startsWith(prefix)) {
    const rt = canonical.slice(prefix.length);
    if (/^[A-Z][A-Za-z]+$/.test(rt)) return { url: canonical, resourceTypes: [rt], interactions: ALL_INTERACTIONS };
  }
  return null;
}

/** Every topic canonical the server advertises (for CapabilityStatement + $topic-list). */
export function knownTopicCanonicals(resourceTypesInStore: string[]): string[] {
  return [
    ...operatorTopics.map((t) => t.url),
    ...resourceTypesInStore.map(typeTopicUrl),
  ];
}

/** Does a topic cover a (resourceType, interaction) change? */
export function topicCovers(topic: SubscriptionTopicDef, resourceType: string, interaction: "create" | "update" | "delete"): boolean {
  const typeOk = topic.resourceTypes.includes("*") || topic.resourceTypes.includes(resourceType);
  return typeOk && topic.interactions.includes(interaction);
}
