/**
 * Catalog / governance binding seam (ADR-0025).
 *
 * Maps a logical (tier, resourceType) to a physical Delta location + a query name.
 * The default `PathCatalog` is path-based / no-metastore — the simplest self-hosted
 * binding (ADR-0025 §2). Cloud-native (Purview / BigLake) and OSS (Unity Catalog OSS)
 * bindings implement the same interface later (ADR-0025 §3-5).
 */

export type Tier = "bronze" | "silver" | "gold";
/** Install-time storage topology ([[storage-topology]]). */
export type StorageMode = "single" | "medallion";

export interface Catalog {
  /** Physical Delta location for a (tier, resourceType). */
  tablePath(tier: Tier, resourceType: string): string;
  /** Logical name a query references this table by. */
  tableName(tier: Tier, resourceType: string): string;
  /** Dead-letter / failed-message queue location for a resource type. */
  deadLetterPath(resourceType: string): string;
  /** Terminology-store table location (codesystem_concept, valueset_expansion, …). */
  terminologyPath(table: string): string;
  /** Conformance-store table location (structuredefinition / installed profiles, …). */
  conformancePath(table: string): string;
  /** Pending-terminology quarantine queue location (resources awaiting a terminology load). */
  pendingTerminologyPath(): string;
  /** Audit-event store location (AuditEvent per PHI access; accounting of disclosures). */
  auditPath(): string;
}

/**
 * Path-based binding: `<base>/<tier>/<resourceType>`. `base` may be a local path or
 * an object-store URI (s3://, gs://, az://) — delta-rs resolves both.
 * Bronze keeps the bare resource name for query continuity; silver/gold are suffixed.
 */
export class PathCatalog implements Catalog {
  private readonly base: string;
  /** Provisioning data (terminology + conformance) follows the topology: in `medallion`
   * it lands under the operational `gold/` prefix (Gold-only — no Bronze raw landing per
   * the storage-topology decision); in `single` it lives directly under the one store. */
  private readonly provisionPrefix: string;

  constructor(base: string, mode: StorageMode = "single") {
    this.base = base.replace(/\/$/, "");
    this.provisionPrefix = mode === "medallion" ? "gold/" : "";
  }

  tablePath(tier: Tier, resourceType: string): string {
    return `${this.base}/${tier}/${resourceType.toLowerCase()}`;
  }

  tableName(tier: Tier, resourceType: string): string {
    const rt = resourceType.toLowerCase();
    return tier === "bronze" ? rt : `${rt}_${tier}`;
  }

  deadLetterPath(resourceType: string): string {
    return `${this.base}/deadletter/${resourceType.toLowerCase()}`;
  }

  terminologyPath(table: string): string {
    return `${this.base}/${this.provisionPrefix}terminology/${table}`;
  }

  conformancePath(table: string): string {
    return `${this.base}/${this.provisionPrefix}conformance/${table}`;
  }

  pendingTerminologyPath(): string {
    return `${this.base}/pending/terminology`;
  }

  auditPath(): string {
    return `${this.base}/audit/audit_event`;
  }
}
