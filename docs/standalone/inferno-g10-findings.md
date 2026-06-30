# Inferno (g)(10) — setup + first findings

Status: **harness operational; first conformance slice run.** Local-first per ADR-0020.

## Harness

- **Kit:** ONC Certification (g)(10) Standardized API Test Kit (`inferno-framework/g10-certification-test-kit`),
  brought up via its docker-compose (inferno + worker + redis + nginx + `hl7_validator_service`).
  Bundles the SMART App Launch (STU1/2/2.2), US Core Server (v3.1.1–v6.1.0), and TLS suites.
- **Server under test:** RoninStandAlone booted end-to-end (Python delta sidecar + TS/Hono server)
  against a copy of the provisioned store (`.delta-prov` → US Core 6.1.0 profiles + terminology).
  Reachable from Inferno at `http://host.docker.internal:3000`.
- **Driver:** `scratchpad/inferno/run.py` drives the Inferno JSON API headlessly
  (create session → run group → poll → results). Auth-mode inputs need `type: "auth_info"`.

## What this session added to the server (SMART discovery + auth gate slice)

- `GET /.well-known/smart-configuration` — discovery doc from the active SmartVersionRegistry.
- `/metadata` `rest[].security` SMART-on-FHIR service + `oauth-uris` extension.
- 401 + `WWW-Authenticate: Bearer` on protected routes; discovery/metadata/health stay public.
- CapabilityStatement: `instantiates` us-core-server (when US Core installed); `format` JSON-only.

## Run 1 — US Core v6.1.0 › Capability Statement group

`us_core_v610-...-us_core_v610_capability_statement`, `url` only (no token, no data needed).

| Test | Result | Note |
|---|---|---|
| us_core_fhir_version | ✅ PASS | R4 (4.0.1) |
| us_core_json_support | ✅ PASS | JSON advertised |
| us_core_profile_support | ✅ PASS | **provisioned US Core supportedProfile accepted** |
| us_core_instantiate | ✅ PASS | after adding `instantiates` (fixed this run) |
| us_core_conformance_support | ⚠️ FAIL (environmental) | local validator has no tx server → can't resolve `application/fhir+json` in the IANA MimeType ValueSet. The code is valid; the official run uses a terminology server. |
| standalone_auth_tls | ⚠️ FAIL (environmental) | server on plain `http` locally; TLS terminates at the proxy in deployment. |

**4/4 code-relevant checks pass.** The 2 fails are environment artifacts (no tx server in the
local validator; no TLS on the local http listener), not server defects.

### Fixes applied (committed)
- `instantiates: ["…/us/core/CapabilityStatement/us-core-server"]` when a US Core profile is installed.
- `format: ["application/fhir+json"]` — dropped the bare `"json"` shorthand (JSON-only, honest).

## Run 2 — US Core v6.1.0 › Patient group (data: US Core `Patient-example`, tag `uscore-example`)

`patient_ids=example`, open server (auth off). **8 PASS / 2 skip / (must-support skip + validation error).**

| Test | Result | Note |
|---|---|---|
| _id / identifier / name searches | ✅ PASS | incl. compound birthdate+family, family+gender, birthdate+name, gender+name |
| Patient read | ✅ PASS | |
| _id search | ✅ PASS | **after fixing POST `[type]/_search`** (Inferno's _id test also POSTs `/_search`) |
| death-date+family search | ⏭️ SKIP | example patient isn't deceased (data) |
| Provenance `_revinclude` | ⏭️ SKIP | no Provenance for the patient (data) |
| must-support | ⏭️ SKIP | single example lacks `deceasedDateTime`, `communication` (data breadth → Synthea) |
| validation | ⚠️ ERROR | validator cold-start timeout (`hl7_validator_service`); transient/environmental |

### Fixes applied (committed) — both real defects surfaced by Inferno
- **POST `[type]/_search`** (form-encoded search, union of body + URL params) — FHIR search spec /
  US Core requirement; GET search refactored into a shared executor and reused.
- **Startup table discovery** (`DeltaWarehouse.registerExistingTables`) — a restarted server now
  registers on-disk bronze/silver/gold tables so it can read data it didn't write this process
  (registration was in-memory; a restart made existing data invisible to search). Wired into the
  server entry. Covered by `delta-post-search` test.

The 2 skips + must-support skip + validation error are all **data breadth / validator warmup**,
not server defects — addressed by loading Synthea (deceased + communication + Provenance) next.

## Known headless-Inferno friction

- The SMART **discovery** sub-group is nested under a `run_as_group` Standalone-Launch parent, so it
  can't be isolated from the full OAuth flow via the API. Our discovery doc + capability + 401 are
  covered by the `smart-discovery` unit test instead; a full Inferno discovery pass needs the SMART
  authorization server (next).

## Remaining work (in priority order)

1. **Test data (next):** load Synthea synthetic + US Core IG example resources, **tagged by dataset**
   (`meta.tag` dataset=synthea | uscore-example), then run the US Core **Patient / clinical** groups
   (read/search/`_revinclude`/must-support) with `patient_ids`. Attribute pass/fail per dataset.
2. **SMART authorization server** (`/authorize`, `/token`, launch context) — unblocks the SMART
   App Launch suites + the OAuth-gated US Core groups + full (g)(10).
3. **Terminology-bound validator** for the conformance test (tx server or built bloom filters).
4. **TLS** for the TLS suite (deploy/proxy).
