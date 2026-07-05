# Docker quickstart — zero to a running FHIR server

Prereqs: Docker (with Compose v2). That's it — no Node, no Python.

## 1. Get the code + config

```bash
git clone https://github.com/FHIRmedicConsulting/fhirEngine.git
cd fhirEngine/deploy
cp .env.example .env        # dev defaults: local Delta volume, port 3000, synthetic data only
```

(Prefer a guided setup? `cd ../packages/server && npm install && npm run init` walks through
storage, auth, TLS, and audit, and writes `deploy/.env` for you — needs Node 20+.)

## 2. Start the stack

**Prebuilt images** (fastest — published to GHCR on every release):

```bash
docker compose -f docker-compose.yml -f docker-compose.images.yml pull
docker compose -f docker-compose.yml -f docker-compose.images.yml up --no-build -d
```

Pin a version by setting `FHIRENGINE_IMAGE_TAG=v0.1.0-alpha.1` in `.env` (default `latest`).
(Images publish with each release tag — if the pull 404s, no release exists yet; build from
source below.)

**Or build from source:**

```bash
docker compose up --build -d
```

Two containers come up: the FHIR server (`:3000`) and the Delta storage sidecar
(internal). The server only reports healthy once it can reach storage.

## 3. Smoke it

```bash
curl -s http://localhost:3000/metadata | head -c 300          # CapabilityStatement
curl -s -X POST http://localhost:3000/Patient \
  -H 'Content-Type: application/fhir+json' \
  -d '{"resourceType":"Patient","id":"quickstart","gender":"female"}'
curl -s http://localhost:3000/Patient/quickstart
curl -s "http://localhost:3000/Patient?gender=female"
```

Transaction bundles POST to the base URL:

```bash
curl -s -X POST http://localhost:3000 -H 'Content-Type: application/fhir+json' \
  --data-binary @my-bundle.json
```

(Bundles over 10 MiB: raise `FHIRENGINE_MAX_BODY_BYTES` in `.env`.)

## 4. Where to go next

| Want | Do |
|---|---|
| US Core profiles + terminology | `cd ../packages/server && npx tsx scripts/fhirengine-terminology.ts install-ig <package-dir> hl7.fhir.us.core --pull-vsac` (needs Node; run while the stack is up) |
| Enforce profiles on writes | `FHIRENGINE_VALIDATION_PROFILES=hl7.fhir.us.core` in `.env` (default validates base FHIR R4 only) |
| Cloud storage (S3/GCS/Azure/MinIO/R2) | set `FHIRENGINE_DELTA_BASE=s3://…` + creds in `.env` — see [README.md](README.md) |
| Auth (SMART), audit, TLS | the wizard (`npm run init`) or [.env.example](.env.example) — every knob is documented inline |
| **Production / PHI** | add the fail-closed overlay: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` — refuses to boot until auth + audit + transport security are configured |

Dev profile is **synthetic data only** — the production overlay is the deploy gate for PHI.
Full deployment guide: [README.md](README.md) · configuration reference:
[docs/standalone/configuration.md](../docs/standalone/configuration.md).

## Stop / reset

```bash
docker compose down             # stop (data persists in the named volume)
docker compose down -v          # stop AND delete all stored data
```
