# RoninStandAlone — self / cloud-hosted deployment

The non-Databricks deployment mode (ADR-0028): the **TS/Hono FHIR server** + the
**delta-rs / DataFusion storage sidecar** (ADR-0029, ADR-0022 A1), with Delta on a
**local volume** or any **object store** (S3 / GCS / Azure / MinIO / R2). No
Databricks, no Spark, no JVM.

```
            ┌──────────────┐      HTTP       ┌────────────────────────┐
  client ──▶│  server      │ ───────────────▶│  sidecar (delta-rs)    │──▶ Delta
  (FHIR)    │  TS/Hono :3000│   write/query   │  + DataFusion :8077    │   (volume
            └──────────────┘                 └────────────────────────┘    or s3://…)
```

Single-writer invariant (ADR-0026): run **one** sidecar.

## Run locally

```bash
cd deploy
cp .env.example .env          # defaults to a local Delta volume
docker compose up --build     # server on http://localhost:3000
```

Smoke it (synthetic data):
```bash
curl -s -X POST http://localhost:3000/Patient -H 'Content-Type: application/fhir+json' \
  -d '{"resourceType":"Patient","id":"p1","identifier":[{"system":"urn:x","value":"1"}],"gender":"female"}'
curl -s http://localhost:3000/Patient/p1
curl -s "http://localhost:3000/Patient?identifier=urn:x|1"
curl -s http://localhost:3000/metadata
```

## Run against cloud object storage (self-hosted cloud)

Set the base to an object-store URI + creds in `.env` — no volume needed:
```bash
RONIN_DELTA_BASE=s3://my-bucket/ronin
AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_REGION=…
AWS_S3_ALLOW_UNSAFE_RENAME=true   # native AWS S3, single-writer (omit for R2/MinIO/GCS)
```
Then `docker compose up --build`. (GCS: `gs://…` + `GOOGLE_SERVICE_ACCOUNT`; Azure:
`az://…` + `AZURE_STORAGE_ACCOUNT_*`.) Deploy the same compose on any VM / k8s / cloud
container host.

## ⚠️ Before real PHI (not in this build)

This deployment has **no auth and no TLS** — **synthetic data only**. Per the PHI
posture (`phi-security-standards` memory) wire these first:
- **TLS** termination in front (transmission security);
- **SMART/UDAP** auth (ADR-0006) + **AuditEvent** capture (ADR-0016);
- **encryption at rest** (object-store SSE/KMS).

## Status / limitations (honest)

- **Not yet built/run in CI** — the deploy host needs a running Docker daemon; the
  Compose file is config-validated (`docker compose config`) but images haven't been
  built here.
- Server runs via **tsx** (no compile step). Follow-up: compile to `dist` for a
  leaner production image (the heritage `build` script is dbignite-coupled).
- Storage CRUD is **Bronze-only** so far (create/read/update/delete/identifier-search);
  Silver/Gold promotion (ADR-0026) and catalog binding (ADR-0025, path-based default)
  are the next layers.
- Object-store write verified by design (delta-rs native); **exercise S3/GCS/Azure on
  a real bucket** before production.
