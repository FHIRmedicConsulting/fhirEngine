/**
 * DeltaWarehouse — the standalone (no-Databricks) storage backend.
 *
 * Single engine per ADR-0022 Amendment 1: delta-rs writes / DataFusion reads,
 * via the Python sidecar (`sidecar/delta_sidecar.py`) over local HTTP. No Spark,
 * no JVM, no Databricks.
 *
 * Role split (the sidecar does the heavy lifting):
 *  - WRITE  → delta-rs (append to Bronze; MERGE for current-version upsert)
 *  - READ   → DataFusion (delta-rs `QueryBuilder`) over the Delta tables
 *
 * The `Warehouse.query()` read path is a DataFusion-SQL passthrough. Writes use the
 * typed `writeBronze`/`merge` methods (delta-rs is row-based, not SQL), so
 * `execute(sql)` is intentionally not wired for the OSS-Delta path yet — the
 * standalone repository write path calls the typed methods. See ADR-0022 A1.
 */

import type { Warehouse, WarehouseRow } from "./warehouse.js";
import type { IdentifierIndexEntry } from "../repository/types.js";
import type { SearchIndexEntry } from "../repository/search-index.js";
import { PathCatalog } from "./catalog.js";
import type { Catalog, Tier, StorageMode } from "./catalog.js";

export interface DeltaWarehouseOptions {
  /** Sidecar base URL, e.g. http://127.0.0.1:8077 */
  sidecarUrl: string;
  /** Delta root the sidecar writes under (must match the sidecar `--base`). */
  base: string;
  /** Catalog/governance binding (ADR-0025). Defaults to path-based. */
  catalog?: Catalog;
  /** Storage topology ([[storage-topology]]). Default 'single' (dev). Governs where
   * provisioning data (terminology/conformance) lands; medallion → under gold/. */
  storageMode?: StorageMode;
}

/** Raw Bronze row (Layering B: Bronze is the raw JSON landing — not flattened). */
export interface RawBronzeRow {
  id: string;
  version_id: number;
  last_updated: string;
  body_json: string;
  identifier_index: IdentifierIndexEntry[];
  search_param_index: SearchIndexEntry[];
  ext_json: string;
  deleted: boolean;
  _ingested_at: string;
  _ingest_source: string;
}

/** Compaction/vacuum options. `vacuum` reclaims unreferenced files; retention defaults to a
 * safe 168h (7d, enforced) to preserve time-travel; `force` drops enforcement (dev/tests). */
export interface OptimizeOpts { vacuum?: boolean; retentionHours?: number; force?: boolean }
function optimizeBody(o?: OptimizeOpts): Record<string, unknown> {
  return { vacuum: o?.vacuum ?? false, retention_hours: o?.retentionHours ?? 168, force: o?.force ?? false };
}

/** Result of a validated Bronze write (valid → Bronze; invalid → dead-letter queue). */
export interface BronzeWriteResult {
  written: number;
  deadlettered: number;
  errors: { id: string | null; resourceType: string | null; error: string }[];
  version: number | null;
}

/** Inline a positional param as a DataFusion SQL literal (no binding in QueryBuilder). */
function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${String(v).replace(/'/g, "''")}'`;
}

export class DeltaWarehouse implements Warehouse {
  private readonly sidecarUrl: string;
  private readonly catalog: Catalog;
  /** Logical table name → Delta path, registered for DataFusion queries. */
  private readonly tables = new Map<string, string>();

  constructor(opts: DeltaWarehouseOptions) {
    this.sidecarUrl = opts.sidecarUrl.replace(/\/$/, "");
    const mode = opts.storageMode ?? (process.env.RONIN_STORAGE_MODE === "medallion" ? "medallion" : "single");
    this.catalog = opts.catalog ?? new PathCatalog(opts.base, mode);
  }

  /** Register a logical table name → path so queries can reference it. */
  registerTable(name: string, path: string): void {
    this.tables.set(name, path);
  }

  /** True once a table has been written/registered (its Delta path exists). */
  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  /** Register a tier table for queries (use before reading one this process didn't write). */
  registerTier(tier: Tier, resourceType: string): string {
    const name = this.catalog.tableName(tier, resourceType);
    this.registerTable(name, this.catalog.tablePath(tier, resourceType));
    return name;
  }

  /** Register the dead-letter / failed-message queue table (for inspection/reprocessing). */
  registerDeadLetter(resourceType: string): string {
    const name = `${resourceType.toLowerCase()}_deadletter`;
    this.registerTable(name, this.catalog.deadLetterPath(resourceType));
    return name;
  }

  /** Register a terminology-store table for queries. */
  registerTerminology(table: string): string {
    this.registerTable(table, this.catalog.terminologyPath(table));
    return table;
  }

  /** Write rows to a terminology-store table (flat string rows → inferred schema). */
  async writeTerminology(table: string, rows: unknown[], mode: "append" | "overwrite" = "append"): Promise<void> {
    const path = this.catalog.terminologyPath(table);
    this.registerTable(table, path);
    await this.post("/write", { table_path: path, rows, mode, schema: "infer" });
  }

  /** Register a conformance-store table for queries. */
  registerConformance(table: string): string {
    this.registerTable(table, this.catalog.conformancePath(table));
    return table;
  }

  /** Write rows to a conformance-store table (installed profiles, etc.). */
  async writeConformance(table: string, rows: unknown[], mode: "append" | "overwrite" = "append"): Promise<void> {
    const path = this.catalog.conformancePath(table);
    this.registerTable(table, path);
    await this.post("/write", { table_path: path, rows, mode, schema: "infer" });
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.sidecarUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`delta sidecar ${route} ${res.status}: ${json.error} ${json.detail ?? ""}`);
    }
    return json as T;
  }

  /** Sidecar liveness (used by tests / startup). */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.sidecarUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Append rows to a tier table (delta-rs). schema: "bronze" (fixed) | "infer" (Silver). */
  async writeTier(
    tier: Tier,
    resourceType: string,
    rows: unknown[],
    schema: "bronze" | "infer" = "bronze",
    mode: "append" | "overwrite" = "append",
  ): Promise<void> {
    const path = this.catalog.tablePath(tier, resourceType);
    this.registerTable(this.catalog.tableName(tier, resourceType), path);
    await this.post("/write", { table_path: path, rows, mode, schema });
  }

  /** MERGE-upsert rows into a tier table by key (e.g. Gold current-version). */
  async mergeTier(
    tier: Tier,
    resourceType: string,
    rows: unknown[],
    key = "id",
    schema: "bronze" | "infer" = "bronze",
  ): Promise<void> {
    const path = this.catalog.tablePath(tier, resourceType);
    this.registerTable(this.catalog.tableName(tier, resourceType), path);
    await this.post("/merge", { table_path: path, rows, key, schema });
  }

  /**
   * Validate (R4 Core, PRIOR to Bronze) then append. Invalid resources are routed
   * to the dead-letter / failed-message queue (a Delta table), NOT to Bronze.
   * Returns the write result so callers can surface a 422 / count failures.
   */
  async writeBronze(resourceType: string, row: RawBronzeRow): Promise<BronzeWriteResult> {
    const path = this.catalog.tablePath("bronze", resourceType);
    // Plain append — validation now runs in the shared TS tier PRIOR to this call
    // (ADR-0028 / validation-approach migration); the sidecar is a pure writer.
    const result = await this.post<BronzeWriteResult>("/write", {
      table_path: path,
      rows: [row],
      mode: "append",
      schema: "bronze",
    });
    if (result.written > 0) {
      this.registerTable(this.catalog.tableName("bronze", resourceType), path);
    }
    return result;
  }

  /**
   * Compact one tier's Delta table (+ optional vacuum). Append-per-write makes many small
   * files; periodic compaction keeps scans fast. Vacuum defaults to a SAFE 168h retention
   * (enforced) preserving time-travel; `force` drops enforcement for dev/tests.
   */
  async optimize(tier: Tier, resourceType: string, opts?: OptimizeOpts): Promise<unknown> {
    return this.post("/optimize", { table_path: this.catalog.tablePath(tier, resourceType), ...optimizeBody(opts) });
  }

  /**
   * Compact (+ optional vacuum) EVERY Delta table under the store base — Bronze resource
   * tables, audit, terminology, conformance, dead-letter, pending. The store maintenance op.
   */
  async optimizeAll(opts?: OptimizeOpts): Promise<unknown> {
    return this.post("/optimize-all", optimizeBody(opts));
  }

  /** Register the audit-event store for querying (accounting of disclosures). */
  registerAudit(): string {
    const path = this.catalog.auditPath();
    this.registerTable("audit_event", path);
    return path;
  }

  /** Append an AuditEvent (append-only per FHIR/ADR-0016) to the audit store. */
  async writeAudit(row: Record<string, unknown>): Promise<void> {
    const path = this.catalog.auditPath();
    await this.post("/write", { table_path: path, rows: [row], mode: "append", schema: "infer" });
    this.registerTable("audit_event", path);
  }

  /** Register the pending-terminology quarantine queue for querying. */
  registerPendingTerminology(): string {
    const path = this.catalog.pendingTerminologyPath();
    this.registerTable("pending_terminology", path);
    return path;
  }

  /** Append rows to the pending-terminology quarantine queue. */
  async writePendingTerminology(rows: unknown[]): Promise<void> {
    const path = this.catalog.pendingTerminologyPath();
    await this.post("/write", { table_path: path, rows, mode: "append", schema: "infer" });
    this.registerTable("pending_terminology", path);
  }

  /** Delete pending-terminology rows matching a SQL predicate (after resolve/dead-letter). */
  async deletePendingTerminology(predicate: string): Promise<void> {
    await this.post("/delete", { table_path: this.catalog.pendingTerminologyPath(), predicate });
  }

  /** Delete terminology rows matching a SQL predicate (idempotent per-value-set replace). */
  async deleteTerminology(table: string, predicate: string): Promise<void> {
    await this.post("/delete", { table_path: this.catalog.terminologyPath(table), predicate });
  }

  /** Compact a terminology table (+ optional vacuum), a tier-less table. */
  async optimizeTerminology(table: string, opts?: OptimizeOpts): Promise<unknown> {
    return this.post("/optimize", { table_path: this.catalog.terminologyPath(table), ...optimizeBody(opts) });
  }

  /** Append a failed-validation record to the dead-letter / failed-message queue. */
  async writeDeadLetter(resourceType: string, row: Record<string, unknown>): Promise<void> {
    await this.post("/write", {
      table_path: this.catalog.deadLetterPath(resourceType),
      rows: [row],
      mode: "append",
      schema: "infer",
    });
  }

  // --- Warehouse interface ---

  /** DataFusion-SQL read passthrough; positional `?` params inlined as literals. */
  async query<T extends WarehouseRow = WarehouseRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    let i = 0;
    const resolved = sql.replace(/\?/g, () => literal(params[i++]));
    const tables = Object.fromEntries(this.tables);
    const out = await this.post<{ rows: T[] }>("/query", { sql: resolved, tables });
    return out.rows;
  }

  /**
   * Not wired for OSS Delta: writes are row-based (delta-rs), not SQL. The
   * standalone repository write path uses `writeBronze` / `merge`. Kept explicit
   * so a stray SQL write fails loudly rather than silently no-op'ing.
   */
  async execute(_sql: string, _params?: unknown[]): Promise<number> {
    throw new Error(
      "DeltaWarehouse.execute(sql) is not supported — use writeBronze()/merge() (delta-rs is row-based, ADR-0022 A1).",
    );
  }

  async close(): Promise<void> {
    /* HTTP client; nothing to release. */
  }
}
