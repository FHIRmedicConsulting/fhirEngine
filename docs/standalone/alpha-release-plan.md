# fhirEngine — Alpha Release Plan

_Getting the (formerly **RoninStandAlone**) OSS-Delta FHIR R4 server ready to push to GitHub for a
private alpha. This is the working checklist; check items off as they land._

## Decisions (locked 2026-07-04)

| Decision | Choice |
|----------|--------|
| Product/repo name | **Full rebrand → `fhirEngine`** (name + npm packages + env vars + CLI) |
| Repo visibility | **Private first** — invite alpha testers, flip public later |
| GitHub home | **A dedicated org** (name TBD — needed before the push) |
| Staging | Clean copy at `Projects/fhirEngine` (tracked files only); `Projects/RoninStandAlone/Ronin` kept as fallback |

## Phase 0 — Naming scheme (CONFIRM before the rename)

Proposed canonical mapping (mechanical parts are scripted; prose/branding is hand-edited):

| Kind | Old | New (proposed) |
|------|-----|----------------|
| Display name | `RoninStandAlone` | `fhirEngine` |
| npm scope | `@ronin/fhir-types`, `@ronin/server-ts` | `@fhir-engine/fhir-types`, `@fhir-engine/server` |
| package dir | `packages/ronin-fhir-types`, `packages/ronin-server-ts` | `packages/fhir-types`, `packages/server` |
| env prefix | `RONIN_` (e.g. `RONIN_AUTH_ENABLED`) | `FHIRENGINE_` (e.g. `FHIRENGINE_AUTH_ENABLED`) |
| CLI / bin | `ronin-terminology`, `ronin-audit-verify` | `fhir-engine-terminology`, `fhir-engine-audit-verify` |
| deployment default | `ronin-standalone` | `fhir-engine` |
| CapabilityStatement `software.name` | `RoninStandAlone` | `fhirEngine` |

Notes / editorial judgment (not blind find-replace):
- **"Ronin" (the Databricks sister product)** stays a real, separate product. The README's
  "sister project to Ronin" line is kept/reworded, not renamed — only *this* product becomes fhirEngine.
- **Heritage ADRs + dated session logs** are historical records → left as written (they say "Ronin"
  because that was the name then). A new ADR records the rename.
- Non-secret `op://` references stay (they name a vault path, never a value).

## Phase 1 — Full rebrand (~150 files: 124 `RONIN_`, 30 `@ronin/`, 54 `ronin-`)

1. Scripted, safe substitutions across text files: `@ronin/` → `@fhir-engine/`, `RONIN_` →
   `FHIRENGINE_`, `ronin-standalone` → `fhir-engine`, CLI `ronin-*` → `fhir-engine-*`.
2. Rename package dirs; update root workspace globs + `package.json` `name`/`bin`.
3. Hand-edit branding on: `README.md`, `STATUS.md`, `CHANGELOG.md`, CapabilityStatement,
   `deploy/*` (compose, env templates), config reference, `CLAUDE.md`.
4. New **ADR** documenting the rename (product identity decision).
5. Re-verify (Phase 2 gate).

## Phase 2 — Re-verify (hard gate before anything ships)

- `typecheck` clean · `lint` clean · **181 unit** green · integration green against the sidecar
  (env vars now `FHIRENGINE_*`) · Docker build · CLI bins resolve under new names.

## Phase 3 — Public-repo preflight (safety — even though private first)

- **Secret scan** (`gitleaks`) over the tree *and* the git history that will ship.
- **PHI scan** — confirm test fixtures/docs are Synthea/synthetic only; no real patient data anywhere.
- **Licensing** — `LICENSE` (Apache-2.0) + `NOTICE` + third-party SBOM; confirm `.gitignore` keeps
  licensed terminology release files (SNOMED/LOINC/RxNorm) out (already covered).
- **Internal-content review** — decide keep/trim for `CLAUDE.md` (internal working agreements, names)
  and `docs/status/` session logs (internal narrative). Options: keep, move to a `dev/` path, or drop.
- **README polish** — quickstart, architecture, prominent **alpha** disclaimer, `SECURITY.md` pointer,
  link to the CMS-0057/validation docs; fix the `419onscene/RoninStandAlone` links.
- **Community files** — `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY` (rename refs), issue/PR
  templates, `CODEOWNERS` (new org/handle).
- **CI** — confirm `.github/workflows` run on public Actions with no required private secrets
  (SBOM/npm-audit/pip-audit/gitleaks/Trivy + build/test).

## Phase 4 — Git history

- **Recommended: fresh single "initial commit"** for the alpha repo (the 75-commit heritage history
  can contain long-since-removed content; a clean root commit guarantees nothing stale ships). Keep
  the `Ronin/` repo internally for full history.
- Alternative: keep full history (only if we're confident no secret/PHI ever touched any commit).

## Phase 5 — GitHub (gated on your go-ahead + org name)

1. (You) create/choose the dedicated org.
2. `gh repo create <org>/fhirEngine --private --source . --push` (from the staged folder).
3. Configure: default branch `main`, branch protection, Actions on, tester invites.
4. Later: flip public when the alpha bar is met.

## Resolved (2026-07-04)

- **Naming** — one-word scope `@fhirengine/*`, env prefix `FHIRENGINE_`, CLI `fhirengine-*`, dirs
  `packages/{fhir-types,server}`, display `fhirEngine`. **Done + verified** (181 unit + 22 integration).
- **Git history** — keep full history (76 commits).
- **Internal docs** — `CLAUDE.md` + `docs/status/` dropped from the tip (still in history; scrub via
  rewrite before going public if desired).
- **GitHub** — org **FHIRmedicConsulting**, repo `fhirEngine`, **private** first; maintainer handle
  stays `@419onscene`.

## Post-alpha follow-ups (noted, not blocking)

- History scrub (if the dropped internal docs must be gone from the public repo before flipping public).
- Optional: rename the `op://Ronin/...` 1Password vault reference if/when the vault itself is renamed.
- Enable GitHub **Private Vulnerability Reporting** in repo settings (SECURITY.md links depend on it).
