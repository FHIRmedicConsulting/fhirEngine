/**
 * Generic resource repository for the standalone OSS-Delta backend (ADR-0022).
 *
 * Mirrors {@link GenericResourceRepository}'s CRUD semantics, but talks to a
 * {@link DeltaWarehouse} (delta-rs writes / DataFusion reads) via its typed
 * methods instead of the Spark-dialect SQL `execute()` path. Bronze-only, raw
 * landing per Layering B: the resource's own `id` is preserved; flattening +
 * canonical id happen Bronze→Silver downstream.
 *
 * Read dialect is DataFusion (delta-rs `QueryBuilder`): point read by id, and
 * identifier search via the unnest-subquery form (NOT a lambda) verified in the
 * feasibility review.
 */

import type { Resource as FhirResource } from "@fhirengine/fhir-types";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { uuidv7 } from "../lib/uuid-v7.js";
import { conflict, gone, notFound, preconditionFailed, unprocessable } from "../lib/errors.js";
import { validateResource } from "../validation/validation-chain.js";
import { bronzeRow } from "./ingest.js";
import { quarantineOnUnknown } from "../lib/config.js";
import { kickReconcile } from "../terminology/reconcile.js";

export interface SearchCondition {
  code: string;
  type: string;
  op?: string; // SQL comparison for date/number/quantity, or "sw" (prefix)
  value: string;
  valueIn?: string[]; // reference IN-list (chaining); empty = matches nothing
  system?: string;
  modifier?: string; // exact | contains | not | missing
}

/** Build an index predicate referencing the unnested `t.s` struct (code/value/system). */
function buildIndexPred(c: SearchCondition): { sql: string; args: unknown[] } {
  if (c.modifier === "missing") return { sql: `(t.s.code = ?)`, args: [c.code] }; // presence by code
  if (c.valueIn) {
    if (c.valueIn.length === 0) return { sql: `(1 = 0)`, args: [] }; // chain resolved to nothing
    const ph = c.valueIn.map(() => "?").join(", ");
    return { sql: `(t.s.code = ? AND t.s.value IN (${ph}))`, args: [c.code, ...c.valueIn] };
  }
  switch (c.type) {
    case "string": {
      const v = c.value.toLowerCase();
      if (c.modifier === "exact") return { sql: `(t.s.code = ? AND t.s.value = ?)`, args: [c.code, v] };
      const escaped = v.replace(/[%_]/g, "");
      const pattern = c.modifier === "contains" ? `%${escaped}%` : `${escaped}%`;
      return { sql: `(t.s.code = ? AND t.s.value LIKE ?)`, args: [c.code, pattern] };
    }
    case "date":
      if (c.op === "sw") return { sql: `(t.s.code = ? AND t.s.value LIKE ?)`, args: [c.code, `${c.value}%`] };
      return { sql: `(t.s.code = ? AND t.s.value ${c.op ?? "="} ?)`, args: [c.code, c.value] };
    case "number":
    case "quantity":
      // TRY_CAST so non-numeric index values (other params unnested into the same scan)
      // become NULL → comparison is false, never a cast error.
      return c.system
        ? { sql: `(t.s.code = ? AND TRY_CAST(t.s.value AS DOUBLE) ${c.op ?? "="} ? AND t.s.system = ?)`, args: [c.code, Number(c.value), c.system] }
        : { sql: `(t.s.code = ? AND TRY_CAST(t.s.value AS DOUBLE) ${c.op ?? "="} ?)`, args: [c.code, Number(c.value)] };
    case "reference": {
      // FHIR reference search: a full `Type/id` (or absolute URL) matches exactly; a BARE id
      // (`patient=123`, the common Inferno form) matches any stored `Type/123`. The index
      // stores the resource's own reference form (e.g. `Patient/123`).
      const v = c.value;
      if (/^[A-Za-z]+\/.+/.test(v) || v.includes(":")) {
        return { sql: `(t.s.code = ? AND t.s.value = ?)`, args: [c.code, v] };
      }
      return { sql: `(t.s.code = ? AND (t.s.value = ? OR t.s.value LIKE ?))`, args: [c.code, v, `%/${v}`] };
    }
    default: // token / uri (+ :not, which is categorized negative by the caller)
      return c.system
        ? { sql: `(t.s.code = ? AND t.s.value = ? AND t.s.system = ?)`, args: [c.code, c.value, c.system] }
        : { sql: `(t.s.code = ? AND t.s.value = ?)`, args: [c.code, c.value] };
  }
}

interface BronzeStoredRow {
  [column: string]: unknown;
  id: string;
  version_id: number;
  last_updated: string;
  body_json: string;
  deleted?: boolean | null;
}

export class DeltaResourceRepository {
  readonly resourceType: string;
  /** Bronze logical table name — the WRITE domain: ingest, version chain (history/vread),
   * optimistic locking, and conditional-write uniqueness always run here. */
  private readonly table: string;
  /** SERVE table — where current-state reads/searches run: Gold in medallion (populated by
   * external promotion — Dagster/Databricks/the promote CLI), Bronze in single-store. In
   * medallion a just-ingested resource is NOT servable until promoted (by design). */
  private readonly serveTable: string;

  constructor(
    private readonly wh: DeltaWarehouse,
    resourceType: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.resourceType = resourceType;
    this.table = resourceType.toLowerCase();
    this.serveTable = wh.serveTableName(resourceType);
  }

  /** Land version 1 in Bronze. Source `id` preserved (ingestion/migration); UUIDv7 fallback. */
  async create(input: FhirResource): Promise<FhirResource> {
    const now = this.clock();
    const clientId = input.id; // a caller-supplied id we're asked to preserve
    const fhirId = clientId ?? uuidv7(now.getTime());
    const stamped = this.stamp(input, fhirId, 1, now);
    // Serialize on the table so concurrent writes don't race the version/commit (Priority #3).
    await this.wh.serializeTable("bronze", this.resourceType, async () => {
      // A create that reuses an EXISTING id would land a second version-1 row: the sidecar's
      // demote-and-insert MERGE then flips the old v1 back to is_current AND drops the new body,
      // producing two current rows for one id (invariant break). Reject — use PUT to update.
      if (clientId !== undefined) {
        const existing = await this.currentRow(fhirId);
        if (existing) throw conflict(`${this.resourceType}/${fhirId} already exists — use PUT to update`);
      }
      await this.writeVersion(stamped, 1, now, false);
    });
    return stamped;
  }

  /** Current (latest) version from the SERVE tier. 404 if never existed, 410 if tombstoned. */
  async read(fhirId: string): Promise<FhirResource> {
    const row = await this.serveRow(fhirId);
    if (!row) throw notFound(this.resourceType, fhirId);
    if (row.deleted === true) throw gone(this.resourceType, fhirId);
    return JSON.parse(row.body_json) as FhirResource;
  }

  /** Optimistic-concurrency update (If-Match); appends a new version. */
  async update(
    fhirId: string,
    input: FhirResource,
    expectedVersionId: string | null,
  ): Promise<FhirResource> {
    // The read (currentRow → version N) + write (N+1, demote N) must be atomic w.r.t. other
    // writers to this table, else two concurrent updates both read N and write N+1 (Priority #3).
    return this.wh.serializeTable("bronze", this.resourceType, async () => {
      const row = await this.currentRow(fhirId);
      if (!row) throw notFound(this.resourceType, fhirId);
      const currentVersion = Number(row.version_id);
      if (expectedVersionId !== null && String(currentVersion) !== expectedVersionId) {
        throw preconditionFailed(
          `If-Match version ${expectedVersionId} does not match current version ${currentVersion}`,
        );
      }
      const now = this.clock();
      const newVersion = currentVersion + 1;
      const stamped = this.stamp(input, fhirId, newVersion, now);
      await this.writeVersion(stamped, newVersion, now, false);
      return stamped;
    });
  }

  /** Soft delete (ADR-0010 §8): append a `deleted=true` tombstone version. */
  async delete(fhirId: string): Promise<void> {
    // Atomic read-compute-write on the table chain (Priority #3 TOCTOU).
    await this.wh.serializeTable("bronze", this.resourceType, async () => {
      const current = await this.read(fhirId); // 404/410 guard
      const row = await this.currentRow(fhirId);
      const now = this.clock();
      const newVersion = Number(row!.version_id) + 1;
      await this.writeVersion(this.stamp(current, fhirId, newVersion, now), newVersion, now, true);
    });
  }

  /** All versions of a resource, newest-first (for `_history`). [] if never existed. */
  async history(fhirId: string): Promise<BronzeStoredRow[]> {
    if (!this.wh.hasTable(this.table)) return [];
    return this.wh.query<BronzeStoredRow>(
      `SELECT id, version_id, last_updated, body_json, deleted
       FROM ${this.table} WHERE id = ? ORDER BY version_id DESC`,
      [fhirId],
    );
  }

  /** All versions of all resources of this type, newest-activity-first (type-level `_history`). */
  async historyAll(count: number, offset: number): Promise<{ rows: BronzeStoredRow[]; total: number }> {
    if (!this.wh.hasTable(this.table)) return { rows: [], total: 0 };
    const totalRows = await this.wh.query<{ n: number }>(`SELECT count(*) AS n FROM ${this.table}`);
    const total = Number(totalRows[0]?.n ?? 0);
    const lim = Math.max(0, Math.min(Math.trunc(count), 1000));
    const off = Math.max(0, Math.trunc(offset));
    const rows = await this.wh.query<BronzeStoredRow>(
      `SELECT id, version_id, last_updated, body_json, deleted
       FROM ${this.table} ORDER BY last_updated DESC, version_id DESC LIMIT ${lim} OFFSET ${off}`,
    );
    return { rows, total };
  }

  /** A specific version (vread). 404 if no such version; 410 if that version is a tombstone. */
  async readVersion(fhirId: string, versionId: number): Promise<FhirResource> {
    if (!this.wh.hasTable(this.table)) throw notFound(this.resourceType, fhirId);
    const rows = await this.wh.query<BronzeStoredRow>(
      `SELECT id, version_id, last_updated, body_json, deleted
       FROM ${this.table} WHERE id = ? AND version_id = ? LIMIT 1`,
      [fhirId, versionId],
    );
    if (!rows.length) throw notFound(this.resourceType, `${fhirId}/_history/${versionId}`);
    if (rows[0].deleted === true) throw gone(this.resourceType, fhirId);
    return JSON.parse(rows[0].body_json) as FhirResource;
  }

  /**
   * Unified current-version search over base columns (`_id`, `_lastUpdated`) + the
   * materialized `search_param_index` (token/string/date/number/quantity/uri/reference,
   * with modifiers `:exact` `:contains` `:not` `:missing`). Positive conditions AND
   * together (HAVING count-distinct); negative conditions (`:not`/`:missing=true`) become
   * `NOT IN` exclusions. Returns the requested page + match total.
   */
  async searchByParams(opts: {
    conds?: SearchCondition[];
    id?: string;
    idIn?: string[]; // restrict to these ids (_has results); empty = no rows
    lastUpdated?: Array<{ op: string; value: string }>;
    count: number;
    offset: number;
    sortDesc?: boolean;
    sortParam?: string; // search-param code to sort by (else last_updated)
    sortNumeric?: boolean; // cast the sort key to DOUBLE (number/quantity) so 10 > 9
  }): Promise<{ resources: FhirResource[]; total: number }> {
    if (!(await this.wh.serveTableReady(this.resourceType))) return { resources: [], total: 0 };
    if (opts.idIn && opts.idIn.length === 0) return { resources: [], total: 0 };
    const conds = opts.conds ?? [];

    // cur = current-version, non-deleted rows, pre-filtered by base columns (_id/_lastUpdated).
    // Priority #2: `is_current` is maintained on write → a direct filter, no window-function
    // (PARTITION BY id) scan over all historical versions.
    const baseWhere = ["is_current", "NOT deleted"];
    const baseArgs: unknown[] = [];
    if (opts.id) { baseWhere.push("id = ?"); baseArgs.push(opts.id); }
    if (opts.idIn && opts.idIn.length) { baseWhere.push(`id IN (${opts.idIn.map(() => "?").join(", ")})`); baseArgs.push(...opts.idIn); }
    for (const lu of opts.lastUpdated ?? []) {
      if (lu.op === "sw") { baseWhere.push("last_updated LIKE ?"); baseArgs.push(`${lu.value}%`); }
      else { baseWhere.push(`last_updated ${lu.op} ?`); baseArgs.push(lu.value); }
    }
    const cur = `cur AS (
      SELECT id, body_json, last_updated, search_param_index
      FROM ${this.serveTable} WHERE ${baseWhere.join(" AND ")})`;

    const isNeg = (c: SearchCondition) => c.modifier === "not" || (c.modifier === "missing" && c.value === "true");
    const pos = conds.filter((c) => !isNeg(c));
    const neg = conds.filter(isNeg);

    const clauses: string[] = [];
    const clauseArgs: unknown[] = [];
    const unnested = `(SELECT id, unnest(search_param_index) AS s FROM cur) t`;

    if (pos.length) {
      const built = pos.map((c) => buildIndexPred(c));
      const caseExpr = `CASE ${built.map((b, i) => `WHEN ${b.sql} THEN ${i}`).join(" ")} END`;
      clauses.push(`cur.id IN (SELECT id FROM ${unnested} WHERE (${built.map((b) => b.sql).join(" OR ")}) GROUP BY id HAVING count(DISTINCT ${caseExpr}) = ${pos.length})`);
      clauseArgs.push(...built.flatMap((b) => b.args), ...built.flatMap((b) => b.args)); // WHERE then CASE
    }
    for (const c of neg) {
      const b = buildIndexPred(c);
      clauses.push(`cur.id NOT IN (SELECT id FROM ${unnested} WHERE ${b.sql})`);
      clauseArgs.push(...b.args);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const dir = opts.sortDesc === false ? "ASC" : "DESC";
    const totalRows = await this.wh.query<{ n: number }>(`WITH ${cur} SELECT count(*) AS n FROM cur ${where}`, [...baseArgs, ...clauseArgs]);
    const total = Number(totalRows[0]?.n ?? 0);
    const lim = Math.max(0, Math.min(Math.trunc(opts.count), 1000));
    const off = Math.max(0, Math.trunc(opts.offset));

    // _sort by an indexed param → join a per-id sort key (min value for that code); else last_updated.
    let withClause = `WITH ${cur}`;
    let from = "cur";
    // `, cur.id` is a deterministic tiebreaker so LIMIT/OFFSET paging is STABLE — bulk-loaded
    // resources routinely share a last_updated (or sort key), and without it DataFusion may
    // order ties differently between page requests → the same row on two pages / skipped rows.
    let orderBy = `last_updated ${dir}, cur.id ${dir}`;
    const pageArgs: unknown[] = [...baseArgs];
    if (opts.sortParam) {
      // Numeric/quantity → min over the CAST values (TRY_CAST tolerates non-numeric index rows),
      // else min over the string values (ISO dates/strings sort lexically).
      const keyExpr = opts.sortNumeric ? "min(TRY_CAST(s.value AS DOUBLE))" : "min(s.value)";
      withClause = `WITH ${cur}, sortk AS (SELECT id, ${keyExpr} AS sv FROM ${unnested} WHERE t.s.code = ? GROUP BY id)`;
      pageArgs.push(opts.sortParam); // sortk CTE arg, after cur's baseArgs
      from = "cur LEFT JOIN sortk ON cur.id = sortk.id";
      orderBy = `sortk.sv ${dir}, cur.id ${dir}`;
    }
    pageArgs.push(...clauseArgs);
    const rows = await this.wh.query<{ body_json: string }>(
      `${withClause} SELECT cur.body_json, cur.last_updated FROM ${from} ${where} ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${off}`,
      pageArgs,
    );
    return { resources: rows.map((r) => JSON.parse(r.body_json) as FhirResource), total };
  }

  /**
   * Current-version resources where ANY of `paramCodes` references `reference`
   * (e.g. compartment membership for $everything: subject/patient/performer = Patient/123).
   */
  async findReferencing(paramCodes: string[], reference: string): Promise<FhirResource[]> {
    if (paramCodes.length === 0 || !(await this.wh.serveTableReady(this.resourceType))) return [];
    const placeholders = paramCodes.map(() => "?").join(", ");
    const rows = await this.wh.query<{ body_json: string }>(
      `SELECT DISTINCT body_json FROM (
         SELECT id, body_json, unnest(search_param_index) AS s
         FROM ${this.serveTable} WHERE is_current AND NOT deleted
       ) t WHERE t.s.code IN (${placeholders}) AND t.s.value = ?`,
      [...paramCodes, reference],
    );
    return rows.map((r) => JSON.parse(r.body_json) as FhirResource);
  }

  /** Current-version identifier search (DataFusion unnest-subquery). */
  async searchByIdentifier(system: string, value: string): Promise<FhirResource[]> {
    if (!this.wh.hasTable(this.table)) return [];
    const rows = await this.wh.query<{ body_json: string }>(
      `SELECT DISTINCT body_json FROM (
         SELECT body_json, unnest(identifier_index) AS i
         FROM ${this.table} WHERE is_current AND NOT deleted
       ) t WHERE t.i.system = ? AND t.i.value = ?`,
      [system, value],
    );
    return rows.map((r) => JSON.parse(r.body_json) as FhirResource);
  }

  // --- helpers ---

  /** Current row in the WRITE domain (Bronze) — optimistic locking + version chain. */
  private async currentRow(id: string): Promise<BronzeStoredRow | null> {
    if (!this.wh.hasTable(this.table)) return null;
    const rows = await this.wh.query<BronzeStoredRow>(
      `SELECT id, version_id, last_updated, body_json, deleted
       FROM ${this.table} WHERE id = ? ORDER BY version_id DESC LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Current row in the SERVE tier (Gold in medallion, Bronze in single-store). */
  private async serveRow(id: string): Promise<BronzeStoredRow | null> {
    if (this.serveTable === this.table) return this.currentRow(id);
    if (!(await this.wh.serveTableReady(this.resourceType))) return null;
    const rows = await this.wh.query<BronzeStoredRow>(
      `SELECT id, version_id, last_updated, body_json, deleted
       FROM ${this.serveTable} WHERE id = ? ORDER BY version_id DESC LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  private async writeVersion(
    resource: FhirResource,
    versionId: number,
    now: Date,
    deleted: boolean,
  ): Promise<void> {
    // Validate PRIOR to Bronze in the shared TS ValidationSupportChain (structural +
    // installed-profile required-elements). Invalid → dead-letter queue + 422.
    const vr = await validateResource(resource as unknown as Record<string, unknown>, { warehouse: this.wh });
    if (!vr.valid) {
      await this.wh.writeDeadLetter(this.resourceType, {
        id: resource.id ?? null,
        resourceType: this.resourceType,
        error: vr.issues.map((i) => `${i.path}: ${i.message}`).join("; ").slice(0, 1500),
        body_json: JSON.stringify(resource),
        failed_at: now.toISOString(),
      });
      throw unprocessable(
        `${this.resourceType} failed FHIR validation (dead-lettered): ${vr.issues[0]?.message ?? "invalid"}`,
      );
    }

    // Opt-in: a valid resource binding a not-loaded ValueSet → quarantine (wait-for-terminology),
    // auto-pull the missing VSAC sets + re-validate in the background, then ingest. Default off.
    if (quarantineOnUnknown() && vr.pending?.length) {
      const missing = vr.pending.map((p) => p.valueSet);
      await this.wh.writePendingTerminology([{
        row_id: uuidv7(now.getTime()),
        resource_type: this.resourceType,
        resource_id: resource.id ?? null,
        version_id: versionId,
        last_updated: now.toISOString(),
        deleted,
        body_json: JSON.stringify(resource),
        missing: missing.join(","),
        status: "wait-for-terminology",
        queued_at: now.toISOString(),
      }]);
      kickReconcile(this.wh); // background: pull VSAC + re-validate + ingest
      throw unprocessable(
        `${this.resourceType} quarantined — wait-for-terminology: ValueSet(s) not loaded [${missing.join(", ")}]`,
      );
    }

    // Versions are contiguous (1,2,3…) → the prior current version is versionId-1 (null on create).
    // writeVersionRaw (not writeVersion) because create/update/delete already hold the table's
    // write chain via serializeTable — a self-locking write here would deadlock the chain.
    await this.wh.writeVersionRaw(
      this.resourceType,
      bronzeRow(resource, versionId, now.toISOString(), deleted),
      versionId > 1 ? versionId - 1 : null,
    );
  }

  private stamp(input: FhirResource, fhirId: string, versionId: number, now: Date): FhirResource {
    return {
      ...input,
      id: fhirId,
      meta: { ...(input.meta ?? {}), versionId: String(versionId), lastUpdated: now.toISOString() },
    };
  }
}
