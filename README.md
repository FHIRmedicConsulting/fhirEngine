# RoninStandAlone

An open-source **FHIR R4 server on OSS Delta Lake** — no Databricks, no cloud lock-in.
TypeScript/Hono REST tier over a **delta-rs / DataFusion** storage engine (via a small
Python sidecar). Apache-2.0.

> Sister project to *Ronin* (the Databricks-optimized product). They share the
> backend-agnostic FHIR/REST layers behind a `Warehouse` seam; this repo ships the
> **OSS Delta** backend only.

## Architecture

```
HTTP (Hono)
  └─ auth gate (SMART/UDAP scopes, JWKS) ─ audit (AuditEvent) ─ consent + DS4P labels
       └─ FHIR REST routes  ─ validation (L1–L4 + bindings + slicing, prior to Bronze)
            └─ Warehouse seam ─ DeltaWarehouse (delta-rs write / DataFusion read)
                                   └─ Python sidecar (deltalake + pyarrow)
```

- **Storage topology (install-time):** single Delta store (dev default) or medallion
  (Bronze→Silver→Gold, Gold operational). `RONIN_STORAGE_MODE=single|medallion`.
- **Clean-room columnar flattener** generated from CC0 HL7 R4 StructureDefinitions
  (no proprietary schemas).

## Features

- **Full FHIR R4 REST surface** — CRUD, instance/type/system `_history`, vread,
  CapabilityStatement, `$validate`, rich search (token/string/date/number/quantity/uri/
  reference + modifiers + chaining + `_has` + `_include`/`_revinclude` + `_sort`/
  `_summary`/`_elements` + paging), `$everything`, `$export`, batch/transaction,
  conditional create/update/delete.
- **Validation prior to Bronze** — structural + cardinality + terminology bindings +
  FHIRPath invariants + slicing + installed-profile required-elements; invalid →
  resource-level dead-letter. Optional quarantine-and-auto-resolve for unknown terminology.
- **Provisioning + terminology** — install FHIR IG packages (profiles + carried
  terminology), load operator-supplied SNOMED/LOINC/RxNorm release files, pull VSAC
  value sets ($expand) once at IG load. Pure-local `$validate-code`.
- **Security / privacy / consent (opt-in)** — SMART/UDAP auth, AuditEvent + accounting,
  computable consent, DS4P security-label enforcement, 42 CFR Part 2 + element-level
  redaction. The server *enforces* labels/consent; tagging is done upstream.

## Quickstart

```bash
# 1. Python sidecar (delta-rs / DataFusion)
cd packages/ronin-server-ts/sidecar
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
python delta_sidecar.py --port 8077 --base ./delta &

# 2. Server
cd packages/ronin-server-ts
npm install
RONIN_DELTA_SIDECAR_URL=http://127.0.0.1:8077 RONIN_DELTA_BASE=./delta npm run dev
```

Provisioning CLI: `scripts/ronin-terminology.ts` (`install-ig`, `load-terminology`,
`expand-vsac`, `check-updates`, `reconcile-terminology`, `optimize`).

## Configuration (env)

| Var | Purpose |
|---|---|
| `RONIN_DELTA_SIDECAR_URL` / `RONIN_DELTA_BASE` | sidecar URL + Delta root |
| `RONIN_STORAGE_MODE` | `single` (default) \| `medallion` |
| `RONIN_AUTH_ENABLED` / `RONIN_AUTH_STRATEGY` | auth gate (`stub`\|`jwks`\|`oidc`) |
| `RONIN_AUDIT_ENABLED` | AuditEvent per access |
| `RONIN_CONSENT_ENFORCEMENT` | read-time consent + DS4P label enforcement |
| `RONIN_QUARANTINE_ON_UNKNOWN` | quarantine + auto-resolve unknown terminology |
| `UMLS_API_KEY` | VSAC `$expand` (inject via 1Password `op run`) |

Security controls are **opt-in** (default off for dev); production enablement is a deploy gate.

## Licensing notes

- Apache-2.0. Generated FHIR schemas are clean-room from CC0 HL7 material.
- **SNOMED CT / LOINC / RxNorm and other licensed terminologies are operator-supplied**
  and never redistributed — they're gitignored and loaded under your own license.

## Tests

`npm test` (unit) · `npm run test:delta` (integration; requires a running sidecar).

See `docs/decisions/` (ADRs) and `docs/standalone/` (design notes).
