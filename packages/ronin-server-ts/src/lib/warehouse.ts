/**
 * Warehouse abstraction — the storage seam (ADR-0022 / ADR-0028).
 *
 * Implementations in the standalone (OSS):
 *  - `InMemoryWarehouse` (here) — tests and local dev; Maps mirroring the SQL subset.
 *  - `DeltaWarehouse` (`delta-warehouse.ts`) — delta-rs write / DataFusion read.
 * (The Databricks-backed implementation lives in the separate, private Ronin product
 * repo and plugs into this same interface; it is not part of the OSS distribution.)
 *
 * The interface deliberately surfaces SQL primitives rather than ORM-style
 * methods — the storage shape per ADR-0010 already commits to specific DDL,
 * and abstracting away from SQL would add ceremony with no win.
 *
 * The in-memory SQL dispatch is intentionally pattern-based: each new query
 * shape the generic ResourceRepository emits gets a matcher block here.
 * That keeps the test surface honest — adding a Coverage query shape requires
 * an explicit in-memory pattern, not magical generality.
 */

export interface WarehouseRow {
  [column: string]: unknown;
}

export interface Warehouse {
  /** Run a SELECT-style statement; return all rows. */
  query<T extends WarehouseRow = WarehouseRow>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run an INSERT/UPDATE/DELETE/MERGE-style statement; return affected-row count. */
  execute(sql: string, params?: unknown[]): Promise<number>;
  /** Release any connection resources. */
  close(): Promise<void>;
}

// --- In-memory implementation ---

interface StoredRow {
  fhir_id: string;
  version_id: number;
  last_updated: string;
  body_json: string;
  identifier_index: Array<{ system: string; value: string; typeCode: string | null }>;
  ext: Record<string, unknown>;
  /** Soft-delete tombstone (ADR-0010 §8); undefined on legacy rows. */
  deleted?: boolean;
}

interface ResourceTable {
  /** Append-only Bronze rows. */
  bronze: StoredRow[];
  /** Current-version Gold (one row per fhir_id). */
  gold: Map<string, StoredRow>;
}

/**
 * Loose row shape for non-medallion tables (e.g., gold.patient_link). These
 * don't fit the StoredRow / ResourceTable schema; the in-memory mirror keeps
 * them as plain row arrays, append-only.
 */
type LooseRow = Record<string, unknown>;

export class InMemoryWarehouse implements Warehouse {
  /** Map of `<schema>.<table>` → ResourceTable. */
  private readonly tables = new Map<string, ResourceTable>();
  /** Non-resource tables (patient_link, etc.) — append-only LooseRow arrays. */
  private readonly looseTables = new Map<string, LooseRow[]>();

  async query<T extends WarehouseRow = WarehouseRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const norm = sql.trim().replace(/\s+/g, " ").toLowerCase();

    // SELECT ... FROM gold.<resource>_r4_current WHERE fhir_id = ?
    const goldByFhirId = norm.match(/from gold\.([a-z_0-9]+) where fhir_id =/);
    if (goldByFhirId) {
      const table = this.ensureTable(`gold.${goldByFhirId[1]!}`);
      const id = String(params[0]);
      const row = table.gold.get(id);
      return (row ? [this.shape(row)] : []) as T[];
    }

    // SELECT ... FROM gold.<resource>_r4_current WHERE exists(identifier_index, i -> ...)
    const goldByIdent = norm.match(
      /from gold\.([a-z_0-9]+) where exists\(identifier_index/,
    );
    if (goldByIdent) {
      const table = this.ensureTable(`gold.${goldByIdent[1]!}`);
      const [system, value] = params as [string, string];
      const matches = this.activeGold(table).filter((row) =>
        row.identifier_index.some((i) => i.system === system && i.value === value),
      );
      return matches.map((r) => this.shape(r)) as T[];
    }

    // COUNT(*) FROM gold.<table>
    const goldCount = norm.match(/select count.* from gold\.([a-z_0-9]+)/);
    if (goldCount) {
      const table = this.ensureTable(`gold.${goldCount[1]!}`);
      return [{ count: table.gold.size } as unknown as T];
    }

    // SELECT FROM bronze.<resource>_r4 WHERE id = ? ORDER BY version_id DESC
    // Bronze's key column is `id` (the server-set logical id); fhir_id is Gold-only.
    const bronzeById = norm.match(/from bronze\.([a-z_0-9]+) where id =/);
    if (bronzeById) {
      const table = this.ensureTable(`bronze.${bronzeById[1]!}`);
      const id = String(params[0]);
      const rows = table.bronze
        .filter((r) => r.fhir_id === id)
        .sort((a, b) => b.version_id - a.version_id);
      return rows.map((r) => this.shape(r)) as T[];
    }

    // Coverage temporal active-as-of:
    // FROM gold.coverage_r4_current WHERE beneficiary_id = ? AND status = 'active' AND
    //   (period_start IS NULL OR period_start <= ?) AND (period_end IS NULL OR period_end >= ?)
    // ORDER BY cob_order ASC NULLS LAST
    if (
      norm.includes("from gold.coverage_r4_current") &&
      norm.includes("where beneficiary_id =") &&
      norm.includes("status = 'active'") &&
      norm.includes("period_start")
    ) {
      const table = this.ensureTable("gold.coverage_r4_current");
      const [beneficiaryId, asOf1, asOf2] = params as [string, string, string];
      const asOf = asOf1 ?? asOf2;
      const matches = this.activeGold(table).filter((row) => {
        if (row.ext.beneficiary_id !== beneficiaryId) return false;
        if (row.ext.status !== "active") return false;
        const ps = row.ext.period_start as string | null;
        const pe = row.ext.period_end as string | null;
        if (ps !== null && ps > asOf) return false;
        if (pe !== null && pe < asOf) return false;
        return true;
      });
      matches.sort((a, b) => {
        const oa = (a.ext.cob_order as number | null) ?? Number.MAX_SAFE_INTEGER;
        const ob = (b.ext.cob_order as number | null) ?? Number.MAX_SAFE_INTEGER;
        return oa - ob;
      });
      return matches.map((r) => this.shape(r)) as T[];
    }

    // Coverage history for beneficiary:
    // FROM gold.coverage_r4_current WHERE beneficiary_id = ? ORDER BY period_start DESC NULLS LAST
    if (
      norm.includes("from gold.coverage_r4_current") &&
      norm.includes("where beneficiary_id =") &&
      norm.includes("order by period_start desc")
    ) {
      const table = this.ensureTable("gold.coverage_r4_current");
      const [beneficiaryId] = params as [string];
      const matches = this.activeGold(table).filter(
        (row) => row.ext.beneficiary_id === beneficiaryId,
      );
      matches.sort((a, b) => {
        const pa = (a.ext.period_start as string | null) ?? "";
        const pb = (b.ext.period_start as string | null) ?? "";
        return pb.localeCompare(pa);
      });
      return matches.map((r) => this.shape(r)) as T[];
    }

    // Coverage findByMemberId:
    // FROM gold.coverage_r4_current WHERE member_id = ? AND member_id_system = ?
    if (
      norm.includes("from gold.coverage_r4_current") &&
      norm.includes("where member_id =")
    ) {
      const table = this.ensureTable("gold.coverage_r4_current");
      const [memberId, system] = params as [string, string];
      const matches = this.activeGold(table).filter(
        (row) =>
          row.ext.member_id === memberId && row.ext.member_id_system === system,
      );
      return matches.map((r) => this.shape(r)) as T[];
    }

    // EOB findByPatient:
    // FROM gold.explanationofbenefit_r4_current WHERE patient_id = ?
    //   ORDER BY billable_period_start DESC NULLS LAST
    if (
      norm.includes("from gold.explanationofbenefit_r4_current") &&
      norm.includes("where patient_id =") &&
      !norm.includes("last_updated >=") &&
      !norm.includes("type_code =")
    ) {
      const table = this.ensureTable("gold.explanationofbenefit_r4_current");
      const [patientId] = params as [string];
      const matches = this.activeGold(table).filter(
        (row) => row.ext.patient_id === patientId,
      );
      matches.sort((a, b) => {
        const ba = (a.ext.billable_period_start as string | null) ?? "";
        const bb = (b.ext.billable_period_start as string | null) ?? "";
        return bb.localeCompare(ba);
      });
      return matches.map((r) => this.shape(r)) as T[];
    }

    // EOB findByPatientSince:
    // FROM gold.explanationofbenefit_r4_current WHERE patient_id = ? AND last_updated >= ?
    //   ORDER BY last_updated DESC
    if (
      norm.includes("from gold.explanationofbenefit_r4_current") &&
      norm.includes("where patient_id =") &&
      norm.includes("last_updated >=")
    ) {
      const table = this.ensureTable("gold.explanationofbenefit_r4_current");
      const [patientId, sinceIso] = params as [string, string];
      const matches = this.activeGold(table).filter(
        (row) =>
          row.ext.patient_id === patientId && row.last_updated >= sinceIso,
      );
      matches.sort((a, b) => b.last_updated.localeCompare(a.last_updated));
      return matches.map((r) => this.shape(r)) as T[];
    }

    // EOB findByPatientAndType:
    // FROM gold.explanationofbenefit_r4_current WHERE patient_id = ? AND type_code = ?
    //   ORDER BY billable_period_start DESC NULLS LAST
    if (
      norm.includes("from gold.explanationofbenefit_r4_current") &&
      norm.includes("where patient_id =") &&
      norm.includes("type_code =")
    ) {
      const table = this.ensureTable("gold.explanationofbenefit_r4_current");
      const [patientId, typeCode] = params as [string, string];
      const matches = this.activeGold(table).filter(
        (row) =>
          row.ext.patient_id === patientId && row.ext.type_code === typeCode,
      );
      matches.sort((a, b) => {
        const ba = (a.ext.billable_period_start as string | null) ?? "";
        const bb = (b.ext.billable_period_start as string | null) ?? "";
        return bb.localeCompare(ba);
      });
      return matches.map((r) => this.shape(r)) as T[];
    }

    // Provenance findByTarget (MPI forensic reverse-search per ADR-0012 §8):
    // FROM gold.provenance_r4_current WHERE target_resource_type = ? AND target_resource_id = ?
    //   ORDER BY recorded DESC
    if (
      norm.includes("from gold.provenance_r4_current") &&
      norm.includes("where target_resource_type =") &&
      norm.includes("and target_resource_id =")
    ) {
      const table = this.ensureTable("gold.provenance_r4_current");
      const [targetType, targetId] = params as [string, string];
      const matches = this.activeGold(table).filter((row) =>
        row.ext.target_resource_type === targetType && row.ext.target_resource_id === targetId,
      );
      matches.sort((a, b) =>
        String(b.ext.recorded).localeCompare(String(a.ext.recorded)),
      );
      return matches.map((r) => this.shape(r)) as T[];
    }

    // AuditEvent findByPatient (patient self-view per ADR-0016 §3):
    // FROM gold.auditevent_r4_current WHERE subject_patient_id = ?
    //   [AND recorded >= ?] ORDER BY recorded DESC
    if (
      norm.includes("from gold.auditevent_r4_current") &&
      norm.includes("where subject_patient_id =")
    ) {
      const table = this.ensureTable("gold.auditevent_r4_current");
      const [patientId, sinceIso] = params as [string, string | undefined];
      const matches = this.activeGold(table).filter((row) => {
        if (row.ext.subject_patient_id !== patientId) return false;
        if (sinceIso && (row.ext.recorded as string) < sinceIso) return false;
        return true;
      });
      matches.sort((a, b) =>
        String(b.ext.recorded).localeCompare(String(a.ext.recorded)),
      );
      return matches.map((r) => this.shape(r)) as T[];
    }

    // gold.patient_link lookup by (identifier_system, identifier_value, resource_type, is_active = true)
    // per ADR-0012 §2 — the MPI's dominant lookup path.
    if (
      norm.includes("from gold.patient_link") &&
      norm.includes("where identifier_system =") &&
      norm.includes("and identifier_value =") &&
      norm.includes("and resource_type =") &&
      norm.includes("and is_active = true")
    ) {
      const rows = this.ensureLooseTable("gold.patient_link");
      const [system, value, resourceType] = params as [string, string, string];
      const matches = rows.filter(
        (r) =>
          r.identifier_system === system &&
          r.identifier_value === value &&
          r.resource_type === resourceType &&
          r.is_active === true,
      );
      return matches as T[];
    }

    throw new Error(`InMemoryWarehouse: unsupported query: ${sql.slice(0, 200)}`);
  }

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    const norm = sql.trim().replace(/\s+/g, " ").toLowerCase();

    // INSERT INTO bronze.<table>
    const bronzeInsert = norm.match(/insert into bronze\.([a-z_0-9]+)/);
    if (bronzeInsert) {
      const table = this.ensureTable(`bronze.${bronzeInsert[1]!}`);
      // Params (match writeBronzeRow Bronze INSERT): id, version_id,
      // last_updated, body_json, identifier_index, ext_json, deleted,
      // _ingested_at, _ingest_source, body_json(dup for from_json's flattened
      // columns — ignored here). Stored internally as fhir_id (= the id).
      const [fhirId, versionId, lastUpdated, body, identifierIndex, extJson, deleted] =
        params as [
          string, number, string, string,
          Array<{ system: string; value: string; typeCode: string | null }>,
          string, boolean, ...unknown[],
        ];
      const ext = extJson ? (JSON.parse(extJson) as Record<string, unknown>) : {};
      table.bronze.push({
        fhir_id: fhirId,
        version_id: versionId,
        last_updated: lastUpdated,
        body_json: body,
        identifier_index: identifierIndex,
        ext,
        deleted: deleted === true,
      });
      return 1;
    }

    // MERGE INTO gold.<table>
    const goldMerge = norm.match(/merge into gold\.([a-z_0-9]+)/);
    if (goldMerge) {
      const table = this.ensureTable(`gold.${goldMerge[1]!}`);
      // Params (match ResourceRepository.writeBronzeAndGold Gold MERGE base
      // params): fhir_id, version_id, last_updated, body_json,
      // identifier_index, ext_json, deleted, ...ext columns, body_json(dup for
      // from_json — ignored). ext is reconstructed from ext_json, so trailing
      // params are ignored.
      const [fhirId, versionId, lastUpdated, body, identifierIndex, extJson, deleted] =
        params as [
          string, number, string, string,
          Array<{ system: string; value: string; typeCode: string | null }>,
          string, boolean, ...unknown[],
        ];
      const ext = extJson ? (JSON.parse(extJson) as Record<string, unknown>) : {};
      table.gold.set(fhirId, {
        fhir_id: fhirId,
        version_id: versionId,
        last_updated: lastUpdated,
        body_json: body,
        identifier_index: identifierIndex,
        ext,
        deleted: deleted === true,
      });
      return 1;
    }

    // DELETE FROM gold.<table> WHERE fhir_id = ?
    const goldDelete = norm.match(/delete from gold\.([a-z_0-9]+)/);
    if (goldDelete) {
      const table = this.ensureTable(`gold.${goldDelete[1]!}`);
      const id = String(params[0]);
      const had = table.gold.has(id);
      table.gold.delete(id);
      return had ? 1 : 0;
    }

    // INSERT INTO gold.patient_link (...) VALUES (...) — append a row to the
    // MPI authority table per ADR-0012 §2. Column order matches the
    // PatientLinkRepository INSERT statement.
    if (norm.includes("insert into gold.patient_link")) {
      const rows = this.ensureLooseTable("gold.patient_link");
      const [
        identifier_system,
        identifier_value,
        resource_type,
        fhir_id,
        provisional,
        assigned_at,
        assigned_by_governance_run,
        decision_path,
        match_score,
        decision_evidence,
      ] = params as [
        string, string, string, string,
        boolean, string, string | null,
        string, number | null, string | null,
      ];
      rows.push({
        identifier_system,
        identifier_value,
        resource_type,
        fhir_id,
        is_active: true,
        provisional,
        superseded_link_fhir_id: null,
        assigned_at,
        assigned_by_governance_run,
        decision_path,
        match_score,
        decision_evidence,
      });
      return 1;
    }

    throw new Error(`InMemoryWarehouse: unsupported execute: ${sql.slice(0, 200)}`);
  }

  async close(): Promise<void> {
    // no-op for in-memory
  }

  /** Test helper: reset state. */
  reset(): void {
    this.tables.clear();
  }

  // --- Internal ---

  private ensureTable(key: string): ResourceTable {
    let t = this.tables.get(key);
    if (!t) {
      t = { bronze: [], gold: new Map() };
      this.tables.set(key, t);
    }
    return t;
  }

  private ensureLooseTable(key: string): LooseRow[] {
    let t = this.looseTables.get(key);
    if (!t) {
      t = [];
      this.looseTables.set(key, t);
    }
    return t;
  }

  /**
   * Project a stored row into the wire shape ResourceRepository expects.
   * Promotes ext columns into top-level row keys so query consumers can
   * read them by name (e.g., `row.beneficiary_id`).
   */
  private shape(row: StoredRow): WarehouseRow {
    return {
      fhir_id: row.fhir_id,
      // Bronze's key column is `id`; expose it as an alias so generic Bronze
      // reads (which SELECT id) resolve. Gold consumers use fhir_id.
      id: row.fhir_id,
      version_id: row.version_id,
      last_updated: row.last_updated,
      body_json: row.body_json,
      identifier_index: row.identifier_index,
      ext_json: JSON.stringify(row.ext),
      deleted: row.deleted ?? null,
      ...row.ext,
    };
  }

  /**
   * Non-tombstone current-version rows for a table — the soft-delete filter
   * (ADR-0010 §8) for search/compartment queries. Point reads bypass this so
   * the repository can distinguish a tombstone (410) from not-found (404).
   */
  private activeGold(table: ResourceTable): StoredRow[] {
    return [...table.gold.values()].filter((r) => r.deleted !== true);
  }
}

