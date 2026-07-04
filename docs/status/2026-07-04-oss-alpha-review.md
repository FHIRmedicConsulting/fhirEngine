# RoninStandAlone — Open-Source Alpha Review (2026-07-04)

> **Status 2026-07-04: all ten addressed.** #1 secure-by-default deploy + cruft removed · #2 honest
> claims (+ L4 R4-model-aware) · #3 SECURITY.md · #4 config reference · #5 unsupported-search rejected
> (not silently broadened) · #6 ADR-0023 ratified + NOTICE + governance reconciled · #7 graceful
> shutdown + `/ready` · #8 sidecar pytest · #9 CI trustworthy (de-flaked, fail-hard, boot smoke) ·
> #10 contributor on-ramp. Deferred (documented): the coverage *gate* (needs `@vitest/coverage-v8` +
> merged unit/integration coverage). Detail below is the original review.


Deep review (4 parallel dimensions: OSS readiness · deployment/operability · FHIR completeness/
conformance · testing/CI/debt) to scope the **next top-ten for an open-source alpha release**.

## Headline

The **code is strong** — broad FHIR R4 surface, and the security infrastructure just landed
(ADR-0031..0036: hardened TLS, fail-closed production profile, HTTP hardening, tamper-evident audit,
UDAP). The gap now is the **release wrapper**: the deploy artifacts, OSS hygiene, honest claims, and
the untested Python core lag the code. None are deep engineering; most are S/M. An alpha is close.

## Verified strengths (safe to rely on)

Root `LICENSE` (Apache-2.0) + real README quickstart · `@databricks/sql` already removed (0 refs) ·
CI with audit/SBOM/pip-audit/gitleaks/Trivy · production fail-closed gate wired in `server.ts` ·
non-root + healthchecked images · TLS hot-reload · audit-verify CLI · single storage knob. CRUD /
history / vread / conditional ops / POST `_search` / chaining / `_has` / `_include`+`_revinclude`
(+`:iterate`) / `_summary` / `_elements` / paging / bare-id refs / `$everything` / `$validate` /
batch-transaction / compartment scoping — all verified present.

## The next top ten (ranked for an OSS alpha)

| # | Item | Sev | Effort |
|---|------|-----|--------|
| 1 | **Fix the deploy story + secure-by-default.** `deploy/{docker-compose.yml,README.md,.env.example}` still say "no auth/TLS — synthetic only" and set **zero** security vars, so the one-command run always boots the **dev** profile — contradicts what shipped. Regenerate to ADR-0031..0036; add a `production` compose overlay. Also delete the `src/app 2.ts` + `src/server 2.ts` (and `dist/index.d 2.ts`) backup cruft and add a `.dockerignore`. | **Blocker** | S |
| 2 | **Make the claims honest.** STATUS/README/CapabilityStatement overstate: "passes Inferno (g)(10)" (never run end-to-end w/ SMART auth), "FHIRPath invariants" (L4 runs without the R4 model + silently `ok=true` on throw, depth ≤1 only), "profile/IG validation" (required-elements/bindings + required slices only), and medallion serving (Gold read-path not wired). Reword to what's true; file issues for the rest. | **Blocker** (trust) | S (reword) / M (fixes) |
| 3 | **`SECURITY.md` + vuln-disclosure policy.** For a PHI-capable health server, the most conspicuous OSS omission — no responsible way to report a vulnerability. | High | S |
| 4 | **Consolidate config + complete `.env.example`.** 45 `RONIN_*` vars in `src`, ~10 documented. Ship a full annotated example + a single config reference table (grouped: storage / server / TLS / auth / audit / consent / CORS / rate-limit / OAuth / UDAP / maintenance). | High | S–M |
| 5 | **Composite search silently returns wrong results.** Unsupported composite params (e.g. `code-value-quantity`) are dropped → a *broader* result set with no error. Reject unsupported params (400) instead of silently broadening; same for multi-field `_sort` (currently first-field-only, silent). | High (correctness) | M |
| 6 | **Ratify the license basis + attribution.** ADR-0023 (open-source licensing) is still **Proposed** — the whole product ships under an un-ratified decision; fill the `LICENSE` copyright line and add a `NOTICE` (HL7 CC0 + deps). Reconcile stale governance docs (CLAUDE.md still mandates removing the already-gone `@databricks/sql`; `component-disclosure-review.md` predates ADR-0029). | High (governance) | S (+ optional legal review) |
| 7 | **Graceful shutdown + readiness probe.** No SIGTERM/SIGINT handler → in-flight single-writer Delta commits can be cut on `docker stop`; the maintenance `stop()` is discarded. `/health` is liveness-only and returns ok even with the sidecar down. Add signal handling + a sidecar-pinging readiness endpoint; gate compose `depends_on` on it. | High | S |
| 8 | **Test the Python sidecar.** `sidecar/delta_sidecar.py` (446 LOC) is the core data-integrity layer (write/MERGE/OPTIMIZE/Z-order/VACUUM/CDF + retry/serialization + the null-cast gotchas) with **zero** direct tests — only indirect coverage via TS. Add a pytest suite. | High | M |
| 9 | **Make CI trustworthy.** Fix the flaky `delta-optimize` assertion (asserts an incidental file *count*; use a fresh base + assert behavior `files_after < files_before`), fail hard when the sidecar doesn't come up (the wait loop has no `|| exit 1`; `skipIf(!SIDECAR)` turns a silent skip into a false pass), add a coverage gate + a real server-boot smoke test. | High | S–M |
| 10 | **Contributor on-ramp.** `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/` issue+PR templates, a `CHANGELOG.md`, and `CODEOWNERS`. Plus release automation (tag → version → GH release) and reconcile the "stack pending" wording (ADR-0029 already ratifies TS/Hono). | Medium | S–M |

## Also (beyond the ten, lower priority)

Reproducible runtime image (compile to `dist` + `npm ci` instead of `npx tsx` + `npm install`) ·
pino `redact` paths (runbook claims PHI-safe logs; nothing enforces it) · lint strictness (`no-explicit-any`
+ `no-non-null-assertion` off; 55 `: any`; no `no-floating-promises` — risky for fire-and-forget audit)
· Node/Python test matrix + sidecar lockfile · SPDX/license headers · package publishing metadata
(`repository`/`bugs`/`homepage`/`files`/`bin`) · object-store restart registration (local-FS only today).

## Suggested sequencing

Ship-blockers first: **1, 2, 3, 6** (the release must run securely, claim honestly, be reportable, and
be legally clean). Then correctness + operability: **5, 7, 4**. Then trust-in-quality: **8, 9**. Then
**10** for community. Items 1–3, 6, 7, 9, 10 are mostly S — an alpha wrapper is a few focused days.
