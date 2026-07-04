# fhirEngine — self / cloud-hosted deployment

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
cd packages/server && npm run init   # guided setup — writes deploy/.env
cd ../../deploy
docker compose up --build            # server on http://localhost:3000
```

(Or skip the wizard: `cp .env.example .env` and edit by hand.)

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
FHIRENGINE_DELTA_BASE=s3://my-bucket/ronin
AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_REGION=…
AWS_S3_ALLOW_UNSAFE_RENAME=true   # native AWS S3, single-writer (omit for R2/MinIO/GCS)
```
Then `docker compose up --build`. (GCS: `gs://…` + `GOOGLE_SERVICE_ACCOUNT`; Azure:
`az://…` + `AZURE_STORAGE_ACCOUNT_*`.) Deploy the same compose on any VM / k8s / cloud
container host.

## Production (PHI-capable) — secure by default, fails closed

The base compose runs the **dev** security profile (controls off, SYNTHETIC data only). For a
PHI-capable deployment, add the production overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

This sets `FHIRENGINE_SECURITY_PROFILE=production`, which **refuses to boot** (ADR-0032) unless
authentication + audit + transport security are configured. The security controls that ship
(hardened TLS, HTTP hardening, tamper-evident audit, SMART/Backend-Services/UDAP auth) are real —
you supply the deployment specifics:

- **TLS** — terminate at a proxy/LB in front (default; `FHIRENGINE_TLS_TERMINATED_AT_PROXY=true`) or run
  in-process HTTPS (`FHIRENGINE_TLS_CERT/KEY`, NIST SP 800-52r2 hardened).
- **Auth** — point `FHIRENGINE_AUTH_STRATEGY=jwks` at your IdP's JWKS, or run our OAuth server with
  **static** signing keys (`FHIRENGINE_OAUTH_PRIVATE_KEY/PUBLIC_KEY`).
- **Audit + consent** — on by the overlay; verify with `scripts/fhirengine-audit-verify.ts`.
- **Encryption at rest** — object-store SSE/KMS (operator/platform responsibility).

Full config: `deploy/.env.example` + `docs/standalone/configuration.md`. Security detail + pre-Alpha
checklist: `docs/standalone/security-hardening-and-deployment.md`.

## Status / limitations (honest)

- **Not yet built/run in CI** — the Compose file is config-validated (`docker compose config`) but
  images aren't built in CI here; build them on a Docker host before relying on them.
- Server currently runs via **tsx** (no compile step) — a follow-up compiles to `dist` for a leaner
  production image.
- **Storage serving is single-store** (Bronze current-version); `FHIRENGINE_STORAGE_MODE=medallion`
  Gold-read-path is not yet wired for serving. **Object-store restart-registration is local-FS only**
  today (a restarted server on S3 sees prior data after the first write). Exercise S3/GCS/Azure on a
  real bucket before production.
- **`$export` async persistence** and full profile/IG (L5) validation are in progress — see STATUS.
