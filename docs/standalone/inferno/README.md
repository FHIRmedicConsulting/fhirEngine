# Inferno (g)(10) drivers

Headless drivers for the ONC (g)(10) test kit's JSON API (no browser). Used this session to run
US Core suites against a live RoninStandAlone server. Full context + resume runbook:
`docs/status/session-033-2026-07-02.md` and results in `../inferno-g10-findings.md`.

## Prereqs
- g10 kit up: `git clone https://github.com/inferno-framework/g10-certification-test-kit` →
  `sh setup.sh` → `docker compose up -d` (Inferno UI/API on `http://localhost`).
- **Validator memory fix** (else it OOM-kills, exit 137) — in the kit's
  `docker-compose.background.yml` under `hl7_validator_service.environment`:
  ```yaml
  SESSION_CACHE_DURATION: 10      # was -1 (never expire) → reclaims memory between groups
  JAVA_TOOL_OPTIONS: "-Xmx5g"     # was the ~1.9 GB container default
  ```
- RoninStandAlone server reachable from the container at `http://host.docker.internal:3000`.
- (Optional) point the us_core validator at our local tx server: in the us_core_test_kit gem's
  `v6.1.0/us_core_test_suite.rb`, inside `fhir_resource_validator do`, add
  `cli_context do; txServer 'http://host.docker.internal:3000'; end`, then restart
  `hl7_validator_service` (it caches validator sessions).

## Usage
```bash
# one group (prints per-test PASS/FAIL/SKIP + messages)
python3 run.py <suite_id> <group_or_test_id> url=http://host.docker.internal:3000 \
   patient_ids=<id> 'smart_auth_info={"auth_type":"public"}'

# many groups (compact tally + fails/errors per group)
python3 batch.py <patient_id> <group_id> <group_id> ...
```
Notes: auth-mode inputs need `type:"auth_info"` (run.py adds it for `*auth_info` names). Groups
marked `run_as_group` (e.g. SMART discovery) can't be isolated from their OAuth-launch parent.
Server must be **open** (auth off) since we have no SMART authorization server yet.
