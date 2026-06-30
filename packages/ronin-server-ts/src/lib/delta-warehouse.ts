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
  /** Current-version flag (Priority #2). Search filters `WHERE is_current` instead of a
   * window function over all versions. Maintained atomically by {@link writeVersion}. */
  is_current: boolean;
  _ingested_at: string;
  _ingest_source: string;
}

/** Compaction/vacuum options. `vacuum` reclaims unreferenced files; retention defaults to a
 * safe 168h (7d, enforced) to preserve time-travel; `force` drops enforcement (dev/tests).
 * `zorder`: explicit columns to cluster by, or `false` for plain compaction. Omitted →
 * auto: cluster by `id` where the table has one (Bronze, audit), else plain compaction. */
export interface OptimizeOpts { vacuum?: boolean; retentionHours?: number; force?: boolean; zorder?: string[] | false }
function optimizeBody(o?: OptimizeOpts): Record<string, unknown> {
  const body: Record<string, unknown> = { vacuum: o?.vacuum ?? false, retention_hours: o?.retentionHours ?? 168, force: o?.force ?? false };
  if (o?.zorder !== undefined) body.zorder = o.zorder; // omit → sidecar auto (cluster by id)
  return body;
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
  private readonly base: string;
  /** Logical table name → Delta path, registered for DataFusion queries. */
  private readonly tables = new Map<string, string>();

  constructor(opts: DeltaWarehouseOptions) {
    this.sidecarUrl = opts.sidecarUrl.replace(/\/$/, "");
    this.base = opts.base.replace(/\/$/, "");
    const mode = opts.storageMode ?? (process.env.RONIN_STORAGE_MODE === "medallion" ? "medallion" : "single");
    this.catalog = opts.catalog ?? new PathCatalog(opts.base, mode);
  }

  /** Register a logical table name → path so queries can reference it. */
  registerTable(name: string, path: string): void {
    this.tables.set(name, path);
  }

  /**
   * Discover + register tables already on disk so a freshly-started server can read data it
   * didn't write this process (table registration is otherwise in-memory). Local-FS bases only;
   * object stores register lazily on first write. Returns the registered logical table names.
   */
  async registerExistingTables(): Promise<string[]> {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(this.base)) return []; // object store → skip FS scan
    const fs = await import("node:fs/promises");
    const registered: string[] = [];
    const scan = async (subdir: string, name: (dir: string) => string) => {
      const dir = `${this.base}/${subdir}`;
      let entries: string[] = [];
      try { entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return; }
      for (const d of entries) {
        // a Delta table has a _delta_log/ child
        try { await fs.access(`${dir}/${d}/_delta_log`); } catch { continue; }
        this.registerTable(name(d), `${dir}/${d}`);
        registered.push(name(d));
      }
    };
    await scan("bronze", (d) => d);                 // search/read path (logical name = rt-lower)
    await scan("silver", (d) => `${d}_silver`);
    await scan("gold", (d) => `${d}_gold`);
    return registered;
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
    await this.postWrite(path, "/write", { table_path: path, rows, mode, schema: "infer" });
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
    await this.postWrite(path, "/write", { table_path: path, rows, mode, schema: "infer" });
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

  // --- Single-writer serialization (Priority #3) ---
  // delta-rs is single-writer per table; concurrent commits to the same table conflict.
  private writeChains = new Map<string, Promise<unknown>>();

  /**
   * Serialize all mutating ops to a given table path, so concurrent requests in THIS process
   * never issue overlapping commits to the same single-writer Delta table (the main conflict
   * source). Cross-process conflicts are retried in the sidecar. Reads are not serialized; a
   * failed write never breaks the chain for the next writer. One chain entry per table (bounded).
   */
  private postWrite<T>(path: string, route: string, body: unknown): Promise<T> {
    const prev = this.writeChains.get(path) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.post<T>(route, body));
    this.writeChains.set(path, next.catch(() => {}));
    return next;
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
    await this.postWrite(path, "/write", { table_path: path, rows, mode, schema });
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
    await this.postWrite(path, "/merge", { table_path: path, rows, key, schema });
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
    const result = await this.postWrite<BronzeWriteResult>(path, "/write", {
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
   * Current-version write (Priority #2): atomically insert the new version (`is_current=true`)
   * and demote the prior version (`is_current=false`) in ONE Delta commit, so readers never see
   * two-current or zero-current for an id. `prevVersionId` is the version being demoted (null on
   * first create). Reads/search then filter `WHERE is_current` — no window-function over history.
   */
  async writeVersion(resourceType: string, row: RawBronzeRow, prevVersionId: number | null): Promise<void> {
    const path = this.catalog.tablePath("bronze", resourceType);
    await this.postWrite(path, "/write-version", { table_path: path, row, prev_version_id: prevVersionId, schema: "bronze" });
    this.registerTable(this.catalog.tableName("bronze", resourceType), path);
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
    await this.postWrite(path, "/write", { table_path: path, rows: [row], mode: "append", schema: "infer" });
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
    await this.postWrite(path, "/write", { table_path: path, rows, mode: "append", schema: "infer" });
    this.registerTable("pending_terminology", path);
  }

  /** Delete pending-terminology rows matching a SQL predicate (after resolve/dead-letter). */
  async deletePendingTerminology(predicate: string): Promise<void> {
    const path = this.catalog.pendingTerminologyPath();
    await this.postWrite(path, "/delete", { table_path: path, predicate });
  }

  /** Delete terminology rows matching a SQL predicate (idempotent per-value-set replace). */
  async deleteTerminology(table: string, predicate: string): Promise<void> {
    const path = this.catalog.terminologyPath(table);
    await this.postWrite(path, "/delete", { table_path: path, predicate });
  }

  /** Compact a terminology table (+ optional vacuum), a tier-less table. */
  async optimizeTerminology(table: string, opts?: OptimizeOpts): Promise<unknown> {
    return this.post("/optimize", { table_path: this.catalog.terminologyPath(table), ...optimizeBody(opts) });
  }

  /** Append a failed-validation record to the dead-letter / failed-message queue. */
  async writeDeadLetter(resourceType: string, row: Record<string, unknown>): Promise<void> {
    const path = this.catalog.deadLetterPath(resourceType);
    await this.postWrite(path, "/write", { table_path: path, rows: [row], mode: "append", schema: "infer" });
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
