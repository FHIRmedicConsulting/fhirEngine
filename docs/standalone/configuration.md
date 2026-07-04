# RoninStandAlone — Configuration Reference

All configuration is via environment variables (12-factor). Copy `deploy/.env.example` → `deploy/.env`
and edit. Secrets: inject via your orchestrator / 1Password `op run` — never commit a real `.env`.

**Legend:** _req(prod)_ = required to boot under `RONIN_SECURITY_PROFILE=production` (fail-closed,
ADR-0032). Related: the security runbook (`security-hardening-and-deployment.md`).

## Storage

| Var | Default | Description |
|---|---|---|
| `RONIN_DELTA_BASE` | `./.delta` (`/data/delta` in Docker) | Delta root — local path **or** object-store URI (`s3://…`, `gs://…`, `az://…`). The server + sidecar must agree. |
| `RONIN_STORAGE_MODE` | `single` | `single` (supported serving) or `medallion` (Bronze→Silver→Gold; **Gold read-path WIP — single only for serving today**). |
| `RONIN_DELTA_SIDECAR_URL` | `http://127.0.0.1:8077` | URL of the delta-rs sidecar (server → sidecar). |

**Object-store credentials** (only when `RONIN_DELTA_BASE` is a cloud URI): `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_ALLOW_UNSAFE_RENAME` (true on native AWS S3 — single
writer, ADR-0026), `GOOGLE_SERVICE_ACCOUNT`, `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`.

## Server

| Var | Default | Description |
|---|---|---|
| `PORT` / `RONIN_PORT` | `3000` | Listen port (`RONIN_PORT` maps the host port in compose). |
| `RONIN_PUBLIC_URL` | `http://localhost:<port>` | Externally-reachable base URL — used in FHIR links/pagination. Set to the real hostname behind a proxy. |
| `RONIN_LOG_LEVEL` | `info` | pino log level. |
| `RONIN_MIGRATE_IS_CURRENT` | off | One-time `is_current` backfill on upgrade (set `true` once). |

## Security profile & transport (ADR-0031/0032)

| Var | Default | Description |
|---|---|---|
| `RONIN_SECURITY_PROFILE` | `dev` | `dev` (warns, synthetic-only) or `production` (fail-closed). |
| `RONIN_TLS_CERT` / `RONIN_TLS_KEY` | — | PEM paths → hardened in-process HTTPS (SP 800-52r2). _req(prod)_ unless proxy-terminated. Hot-reloaded on change. |
| `RONIN_TLS_TERMINATED_AT_PROXY` | — | `true` attests a proxy/LB terminates TLS. _req(prod)_ if not running in-process TLS. |
| `RONIN_TLS_CIPHERS` | NIST SP 800-52r2 list | Advanced: override the TLS 1.2 cipher allow-list. |

## Authentication (ADR-0030)

| Var | Default | Description |
|---|---|---|
| `RONIN_AUTH_ENABLED` | off | Enable the SMART/JWT gate. **_req(prod)_.** |
| `RONIN_AUTH_STRATEGY` | `jwks` | `jwks` \| `oidc` \| `local` (verify our own OAuth server) \| `stub` (tests). |
| `RONIN_JWKS_URI` | — | jwks strategy: the IdP JWKS URL. |
| `RONIN_JWT_PUBLIC_KEY` / `RONIN_JWT_ISSUER` / `RONIN_JWT_AUDIENCE` / `RONIN_JWT_ALG` | — | Static-key JWT validation params. |
| `RONIN_OIDC_DISCOVERY` | — | oidc strategy: issuer discovery URL. |
| `RONIN_SMART_VERSIONS` | all | Active SMART grammars (e.g. `2.0.0,2.2.0`). |
| `RONIN_SMART_AUTHORIZE_URL` / `RONIN_SMART_TOKEN_URL` | — | Advertised in `.well-known/smart-configuration` if using an external AS. |

## SMART authorization server (optional)

| Var | Default | Description |
|---|---|---|
| `RONIN_OAUTH_ENABLED` | off | Run `/oauth/authorize` + `/oauth/token` + JWKS. |
| `RONIN_OAUTH_PRIVATE_KEY` / `RONIN_OAUTH_PUBLIC_KEY` | ephemeral | Static signing keys (PEM). **_req(prod)_ when OAuth enabled** (ephemeral keys rotate on restart). |
| `RONIN_OAUTH_CLIENTS` | dev-open | JSON array of registered clients (locks client_id + redirect_uris). |
| `RONIN_OAUTH_DEFAULT_PATIENT` / `RONIN_OAUTH_DEFAULT_USER` | — | Dev auto-approve launch context. |

## UDAP B2B trust (ADR-0036; opt-in)

| Var | Default | Description |
|---|---|---|
| `RONIN_UDAP_ENABLED` | off | Enable `.well-known/udap` + trusted DCR (`/udap/register`). |
| `RONIN_UDAP_TRUST_ANCHORS` | — | Comma-separated PEM paths of trusted CA anchors. |
| `RONIN_UDAP_REVOKED_CERTS` | — | Revoked cert SHA-256 fingerprints and/or serials (comma-separated) — rejected even if trusted + unexpired. |
| `RONIN_UDAP_REVOKED_CERTS_FILE` | — | ...or a file of them (one per line, `#` comments). |
| `RONIN_UDAP_SERVER_KEY` / `RONIN_UDAP_SERVER_CERT` | — | PEM key + cert chain to emit signed `signed_metadata` at `.well-known/udap`. |

## Audit, consent & HTTP hardening (ADR-0030/0033/0035)

| Var | Default | Description |
|---|---|---|
| `RONIN_AUDIT_ENABLED` | off | Capture (hash-chained) AuditEvents. **_req(prod)_.** |
| `RONIN_AUDIT_ANCHOR_INTERVAL_MIN` | off | Publish signed audit chain-tip anchors every N min (external tamper detection). |
| `RONIN_AUDIT_ANCHOR_WEBHOOK` | — | External append-only sink URL to POST anchors to. |
| `RONIN_AUDIT_ANCHOR_KEY` | — | PEM (PKCS8) key to sign anchors (optional). |
| `RONIN_CONSENT_ENFORCEMENT` | off | Enforce consent/DS4P at read time (advisory in prod). |
| `RONIN_CORS_ORIGINS` | dev: `*` / prod: none | Comma-separated allowlist; prod + empty ⇒ same-origin only. |
| `RONIN_RATE_LIMIT_ENABLED` | prod on / dev off | Per-client rate limiting. |
| `RONIN_RATE_LIMIT_RPM` | `600` | Requests per client per minute. |
| `RONIN_RATE_LIMIT_STORE` | per-node | `redis` for shared limits across instances (lazy-loads `ioredis` — `npm i ioredis`). |
| `RONIN_REDIS_URL` | — | `redis://…` when `RONIN_RATE_LIMIT_STORE=redis`. |
| `RONIN_MAX_BODY_BYTES` | `10485760` | Request body cap (10 MiB) → 413. |

## Maintenance & misc

| Var | Default | Description |
|---|---|---|
| `RONIN_MAINTENANCE_INTERVAL_MIN` | off | OPTIMIZE interval (empty = off). |
| `RONIN_VACUUM_ENABLED` / `RONIN_VACUUM_RETENTION_HOURS` | off | VACUUM during maintenance + its retention window. |
| `RONIN_EXPORT_DIR` | temp | Directory for async `$export` NDJSON output. |
| `RONIN_QUARANTINE_ON_UNKNOWN` / `RONIN_DISABLE_AUTO_RECONCILE` | off | Quarantine-on-unknown-terminology + auto-reconcile toggle. |
| `RONIN_SERVER_DEVICE_ID` / `RONIN_INLINE_LABEL_URL` / `RONIN_AUDIT_DEBUG` | — | AuditEvent source device id · inline-label extension URL · verbose audit logging. |
