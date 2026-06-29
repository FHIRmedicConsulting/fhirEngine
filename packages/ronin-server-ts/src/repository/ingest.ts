/**
 * Shared Bronze-row construction — used by the repository write path AND the terminology
 * reconciler (so a resource ingested after a deferred terminology load is materialized
 * identically: same identifier + search indexes).
 */
import type { Resource as FhirResource } from "@ronin/fhir-types";
import type { RawBronzeRow } from "../lib/delta-warehouse.js";
import type { IdentifierIndexEntry } from "./types.js";
import { buildSearchIndex } from "./search-index.js";

export function extractIdentifiers(resource: FhirResource): IdentifierIndexEntry[] {
  const raw = (resource as { identifier?: unknown }).identifier;
  const list = Array.isArray(raw) ? raw : [];
  const out: IdentifierIndexEntry[] = [];
  for (const id of list) {
    if (id && typeof id === "object") {
      const e = id as { system?: string; value?: string; type?: { coding?: Array<{ code?: string }> } };
      if (e.system || e.value) out.push({ system: e.system ?? "", value: e.value ?? "", typeCode: e.type?.coding?.[0]?.code ?? null });
    }
  }
  return out;
}

export function bronzeRow(resource: FhirResource, versionId: number, lastUpdatedIso: string, deleted: boolean): RawBronzeRow {
  return {
    id: resource.id!,
    version_id: versionId,
    last_updated: lastUpdatedIso,
    body_json: JSON.stringify(resource),
    identifier_index: extractIdentifiers(resource),
    search_param_index: buildSearchIndex(resource as unknown as Record<string, unknown>),
    ext_json: "{}",
    deleted,
    _ingested_at: new Date().toISOString(),
    _ingest_source: "ronin-standalone",
  };
}
