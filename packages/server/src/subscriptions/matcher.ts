/**
 * Subscription matching (Subscriptions R5 Backport IG).
 *
 * A changed resource matches a Subscription when:
 *   1. the Subscription's topic (Subscription.criteria canonical) covers the resource type +
 *      interaction, AND
 *   2. every backport-filter-criteria (`param=value`, FHIR search syntax) matches the resource.
 *
 * Filters are evaluated against the resource's own search index (the same materialization the
 * search route matches against), so a filter uses exactly the semantics a search would — token
 * (bare or system|code), reference (bare id or Type/id), string (prefix), date/number/quantity
 * (prefix ops). Unsupported/unparseable filters DON'T match (fail closed — never over-notify).
 */
import { buildSearchIndex } from "../repository/search-index.js";
import { searchParam } from "../fhir-schema/r4-search-params.js";
import { resolveTopic, topicCovers } from "./topics.js";

export interface ParsedSubscription {
  id: string;
  topicCanonical: string;
  filters: string[]; // raw "param=value" strings
  endpoint: string;
  payloadContent: "empty" | "id-only" | "full-resource";
  mimeType: string;
  headers: string[];
  heartbeatPeriod: number | null;
}

const DATE_PREFIXES = new Set(["eq", "ne", "gt", "lt", "ge", "le", "sa", "eb"]);

function parseFilter(raw: string): { param: string; value: string } | null {
  const eq = raw.indexOf("=");
  if (eq <= 0) return null;
  return { param: raw.slice(0, eq).trim(), value: raw.slice(eq + 1).trim() };
}

/** One filter clause matched against the pre-built index rows for the resource. */
function filterMatches(resourceType: string, index: ReturnType<typeof buildSearchIndex>, param: string, value: string): boolean {
  const code = param.split(":")[0]!; // ignore modifiers for matching (conservative)
  const def = searchParam(resourceType, code);
  if (!def) return false; // unknown param → no match (fail closed)
  const rows = index.filter((r) => r.code === code);
  if (!rows.length) return false;

  const type = def.type;
  if (type === "token") {
    // `system|code`, `|code`, or bare `code`.
    if (value.includes("|")) {
      const [sys, cd] = value.split("|");
      return rows.some((r) => (cd === undefined || r.value === cd) && (sys === "" ? true : r.system === sys));
    }
    return rows.some((r) => r.value === value);
  }
  if (type === "reference") {
    // bare id matches any stored `Type/id`; full `Type/id` matches exactly.
    if (/^[A-Za-z]+\/.+/.test(value)) return rows.some((r) => r.value === value);
    return rows.some((r) => r.value === value || r.value.endsWith(`/${value}`));
  }
  if (type === "string") {
    const v = value.toLowerCase();
    return rows.some((r) => r.value.startsWith(v));
  }
  if (type === "date" || type === "number" || type === "quantity") {
    const m = /^([a-z]{2})?(.+)$/.exec(value);
    const prefix = m?.[1] && DATE_PREFIXES.has(m[1]) ? m[1] : "eq";
    const operand = (m?.[1] && DATE_PREFIXES.has(m[1]) ? m[2] : value) ?? value;
    const numeric = type !== "date";
    return rows.some((r) => compare(r.value, operand, prefix, numeric));
  }
  // uri and anything else → exact
  return rows.some((r) => r.value === value);
}

function compare(rowVal: string, operand: string, prefix: string, numeric: boolean): boolean {
  if (numeric) {
    const a = Number(rowVal), b = Number(operand);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return applyOp(a, b, prefix);
  }
  // date: lexical ISO comparison; `eq` = the row starts with the (possibly partial) operand.
  if (prefix === "eq") return rowVal.startsWith(operand);
  if (prefix === "ne") return !rowVal.startsWith(operand);
  return applyOp(rowVal, operand, prefix);
}

function applyOp<T>(a: T, b: T, prefix: string): boolean {
  switch (prefix) {
    case "gt": case "sa": return a > b;
    case "lt": case "eb": return a < b;
    case "ge": return a >= b;
    case "le": return a <= b;
    case "ne": return a !== b;
    default: return a === b;
  }
}

/**
 * Does the changed resource match the subscription? Topic coverage first, then ALL filters.
 * The resource's search index is built once and shared across filters.
 */
export function subscriptionMatches(
  sub: ParsedSubscription,
  resourceType: string,
  interaction: "create" | "update" | "delete",
  resource: Record<string, unknown>,
): boolean {
  const topic = resolveTopic(sub.topicCanonical);
  if (!topic || !topicCovers(topic, resourceType, interaction)) return false;
  if (!sub.filters.length) return true;
  // A deleted resource is a tombstone (id only) — filters can't be evaluated against a body
  // that no longer carries the coded elements, so a filtered subscription does not fire on
  // delete (the safe, common interpretation; unfiltered delete subscriptions still fire).
  if (interaction === "delete") return false;
  const index = buildSearchIndex(resource);
  for (const raw of sub.filters) {
    const f = parseFilter(raw);
    if (!f || !filterMatches(resourceType, index, f.param, f.value)) return false;
  }
  return true;
}
