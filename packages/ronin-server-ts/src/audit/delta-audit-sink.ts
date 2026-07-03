/**
 * Delta-native AuditEvent sink (ADR-0016 / ADR-0030 control #2). Append-only writes to the
 * audit Delta table; the heritage Spark-dialect `AuditEventRepository` is replaced by this
 * delta-rs writer. `findByPatient` backs accounting-of-disclosures (HITECH).
 */
import type { AuditEvent } from "@ronin/fhir-types";
import type { AuditSink } from "./audit-middleware.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { uuidv7 } from "../lib/uuid-v7.js";

/** Best-effort "whose record was accessed" for accounting (entity Patient, else patient-context). */
function patientOf(event: AuditEvent): string | null {
  const ent = (event.entity?.[0]?.what as { reference?: string } | undefined)?.reference;
  if (typeof ent === "string" && ent.startsWith("Patient/")) return ent.slice("Patient/".length);
  const who = (event.agent?.[0]?.who as { reference?: string } | undefined)?.reference;
  if (typeof who === "string" && who.startsWith("Patient/")) return who.slice("Patient/".length);
  return null;
}

export class DeltaAuditSink implements AuditSink {
  constructor(private readonly wh: DeltaWarehouse) {}

  create(event: AuditEvent): Promise<void> {
    const entity = (event.entity?.[0]?.what as { reference?: string } | undefined)?.reference ?? null;
    // Empty string (not null) for absent values → keeps each Delta column Utf8-stable across
    // appends (a null-only first batch would type the column Null and reject later strings).
    const row = {
      id: event.id ?? uuidv7(Date.now()),
      recorded: event.recorded ?? new Date().toISOString(),
      action: event.action ?? "",
      outcome: event.outcome != null ? String(event.outcome) : "",
      subtype: event.subtype?.[0]?.code ?? "",
      agent_who: (event.agent?.[0]?.who as { reference?: string } | undefined)?.reference ?? "",
      entity_ref: entity ?? "",
      patient: patientOf(event) ?? "",
      body_json: JSON.stringify(event),
    };
    // Concurrent fire-and-forget audit writes to the single-writer audit table are serialized
    // by the warehouse (per-table write chain, Priority #3) — no bespoke chain needed here.
    // Failures surface via the audit middleware's onWriteError (never silent — §164.312(b)).
    return this.wh.writeAudit(row);
  }

  /** Accounting of disclosures for a patient (ADR-0016 §3 / HITECH), newest-first. */
  async findByPatient(patientId: string): Promise<AuditEvent[]> {
    this.wh.registerAudit();
    const rows = await this.wh.query<{ body_json: string }>(
      "SELECT body_json FROM audit_event WHERE patient = ? ORDER BY recorded DESC", [patientId],
    );
    return rows.map((r) => JSON.parse(r.body_json) as AuditEvent);
  }
}
