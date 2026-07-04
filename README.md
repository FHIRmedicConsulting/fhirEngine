# fhirEngine

An open-source **FHIR R4 server on OSS Delta Lake** — no Databricks, no cloud lock-in.
TypeScript/Hono REST tier over a **delta-rs / DataFusion** storage engine (via a small
Python sidecar). Apache-2.0.

> The backend-agnostic FHIR/REST layers sit behind a `Warehouse` seam shared with a
> separate, proprietary Databricks-optimized sibling product; this repo ships the
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
  (Bronze→Silver→Gold, Gold operational). `FHIRENGINE_STORAGE_MODE=single|medallion`.
  _(Alpha: single-store serving is the supported path; the medallion Gold read-path is WIP.)_
- **Clean-room columnar flattener** generated from CC0 HL7 R4 StructureDefinitions
  (no proprietary schemas).

> **Status: pre-alpha.** Broad FHIR surface + a real security baseline (hardened TLS, fail-closed
> production profile, HTTP hardening, tamper-evident audit, SMART/Backend-Services/UDAP). **Not** ONC
> (g)(10)-certified — individual US Core groups pass in Inferno, but the full suite hasn't been run
> end-to-end. Synthetic data only until you configure the production profile. See `STATUS.md`.

## Features

- **Full FHIR R4 REST surface** — CRUD, instance/type/system `_history`, vread,
  CapabilityStatement, `$validate`, rich search (token/string/date/number/quantity/uri/
  reference + modifiers + chaining + `_has` + `_include`/`_revinclude` + `_sort`/
  `_summary`/`_elements` + paging), `$everything`, `$export`, batch/transaction,
  conditional create/update/delete.
- **Validation prior to Bronze** — structural + cardinality + terminology bindings +
  L4 FHIRPath invariants (top-level/one-level) + slicing + installed-profile required-elements
  & bindings (profile enforcement is operator-opt-in via `FHIRENGINE_VALIDATION_PROFILES`;
  default validates the base FHIR version only); invalid → resource-level dead-letter. Optional quarantine-and-auto-resolve for
  unknown terminology. _(Not full L5 IG conformance — no closed/max slices, discriminators, or
  must-support; the authoritative profile verdict is the external HL7 validator.)_
- **Provisioning + terminology** — install FHIR IG packages (profiles + carried
  terminology), load operator-supplied SNOMED/LOINC/RxNorm release files, pull VSAC
  value sets ($expand) once at IG load. Pure-local `$validate-code`.
- **Security / privacy / consent (opt-in)** — SMART auth + Backend Services + UDAP B2B trust,
  AuditEvent + accounting, computable consent, DS4P security-label enforcement, 42 CFR Part 2 +
  element-level redaction. The server *enforces* labels/consent; tagging is done upstream.
- **Security infrastructure** — hardened TLS (NIST SP 800-52r2, cert hot-reload), a **fail-closed
  production profile**, HTTP hardening (headers, enforced CORS, rate limiting, body limits),
  **tamper-evident (hash-chained) audit**, and SBOM + dependency/secret/vuln scanning in CI.
  See `docs/standalone/security-hardening-and-deployment.md` (ADR-0031..0036).

## Quickstart

**Guided setup (recommended):** the wizard walks through storage, security profile,
auth, TLS, and audit, writes `deploy/.env`, previews the boot-time posture check
(ADR-0032), and prints the exact run + provisioning commands:

```bash
cd packages/server && npm install
npm run init
```

**Manual dev boot** (no wizard — dev defaults, synthetic data only):

```bash
# 1. Python sidecar (delta-rs / DataFusion)
cd packages/server/sidecar
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
python delta_sidecar.py --port 8077 --base ./delta &

# 2. Server
cd packages/server
npm install
FHIRENGINE_DELTA_SIDECAR_URL=http://127.0.0.1:8077 FHIRENGINE_DELTA_BASE=./delta npm run dev
```

Provisioning CLI: `scripts/fhirengine-terminology.ts` (`install-ig`, `load-terminology`,
`expand-vsac`, `check-updates`, `reconcile-terminology`, `optimize`).

## Deploy (Docker)

Two containers — the TS/Hono server and the delta-rs storage sidecar — with Delta on a
local volume or any object store (S3 / GCS / Azure / MinIO / R2).

**Prebuilt images** (published to GHCR on every release; no toolchain needed):

```bash
cd deploy
cp .env.example .env                 # or: cd ../packages/server && npm run init
docker compose -f docker-compose.yml -f docker-compose.images.yml pull
docker compose -f docker-compose.yml -f docker-compose.images.yml up --no-build -d
curl -s http://localhost:3000/metadata | head -c 200
```

Pin a version with `FHIRENGINE_IMAGE_TAG=v0.1.0-alpha.1` (default `latest`).

**Build from source:** same, without the images overlay — `docker compose up --build`.

**Production (PHI-capable):** add the fail-closed overlay —
`-f docker-compose.prod.yml` — which refuses to boot until auth, audit, and transport
security are configured (ADR-0032). Both image builds and an end-to-end containerized
boot smoke run in CI on every push. Full guide: [`deploy/README.md`](deploy/README.md).

## Configuration (env)

| Var | Purpose |
|---|---|
| `FHIRENGINE_DELTA_SIDECAR_URL` / `FHIRENGINE_DELTA_BASE` | sidecar URL + Delta root |
| `FHIRENGINE_STORAGE_MODE` | `single` (default) \| `medallion` |
| `FHIRENGINE_AUTH_ENABLED` / `FHIRENGINE_AUTH_STRATEGY` | auth gate (`stub`\|`jwks`\|`local`\|`oidc`) |
| `FHIRENGINE_OAUTH_ENABLED` | SMART authorization server (`/oauth/authorize`, `/oauth/token`, `/.well-known/jwks.json`); pair with `FHIRENGINE_AUTH_STRATEGY=local`. `FHIRENGINE_OAUTH_DEFAULT_PATIENT`/`FHIRENGINE_OAUTH_DEFAULT_USER` set the auto-approve launch context; `FHIRENGINE_OAUTH_CLIENTS` (JSON) locks down clients in prod |
| `FHIRENGINE_AUDIT_ENABLED` | AuditEvent per access |
| `FHIRENGINE_CONSENT_ENFORCEMENT` | read-time consent + DS4P label enforcement |
| `FHIRENGINE_QUARANTINE_ON_UNKNOWN` | quarantine + auto-resolve unknown terminology |
| `UMLS_API_KEY` | VSAC `$expand` (inject via 1Password `op run`) |
| `FHIRENGINE_MAINTENANCE_INTERVAL_MIN` | opt-in periodic Delta compaction (+ `FHIRENGINE_VACUUM_ENABLED`, `FHIRENGINE_VACUUM_RETENTION_HOURS`) |

Security controls are **opt-in** (default off for dev); production enablement is a deploy gate.

## Licensing notes

- Apache-2.0. Generated FHIR schemas are clean-room from CC0 HL7 material.
- **SNOMED CT / LOINC / RxNorm and other licensed terminologies are operator-supplied**
  and never redistributed — they're gitignored and loaded under your own license.

## Tests

`npm test` (unit) · `npm run test:delta` (integration; requires a running sidecar).

See `docs/decisions/` (ADRs) and `docs/standalone/` (design notes).
