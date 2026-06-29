# ADR-0013: Deployment Posture — Databricks-Native, Bundle-First, Apps-Hosted

- Status: **Accepted**
- Date: 2026-06-19
- Decider(s): Chad
- Session: 017 (drafted; built on POC runs sessions 015 + 016)
- Related: [ADR-0008](0008-updated-vision-and-scope.md), [ADR-0009](0009-databricks-partner-posture-and-adr-0008-corrections.md), [ADR-0010](0010-storage-shape.md), [ADR-0011](0011-write-contract.md), [ADR-0012](0012-master-patient-index.md), [docs/research/2026-06-19-deployment-bootstrap-poc-results.md](../research/2026-06-19-deployment-bootstrap-poc-results.md), [docs/status/session-015-2026-06-19.md](../status/session-015-2026-06-19.md), [docs/status/session-016-2026-06-19.md](../status/session-016-2026-06-19.md)

## Context

ADR-0008 + ADR-0009 set Ronin's Databricks Partner posture: multi-cloud via Databricks-on-AWS/Azure/GCP; v1 customer profile a 10M-member payer with room to scale to provider workloads. Chad's session-017 constraint, paraphrased: **"I don't want our system to wind up needing a full consulting engagement to deploy at a customer."** Translation: deployment must be self-service or near-self-service — documented IaC, templated, idempotent, repeatable, customer-runnable.

The deployment-bootstrap POC (sessions 015 + 016) validated the technical posture end-to-end. Two consecutive runs:

- **Session 015 (first run):** PASS with seven discovered fixes — each became a finding for this ADR.
- **Session 016 (re-run with refined bundle):** PASS with **manual steps reduced from seven to exactly one** — schema-level UC grants declared declaratively in the bundle and applied automatically after the App SP was minted; only the catalog-level `USE_CATALOG` grant remained out-of-band, which is inherent because catalogs are pre-existing and customer-owned.

This ADR ratifies the resulting posture and locks the install-flow contract for the v1 bundle.

## Decision

### 1. Distribution channels

- **Primary: Databricks Marketplace listing.** Solution Accelerator format (clonable Git repo containing the bundle + App source + OpenTofu module + install script). Cloud-agnostic — works on Databricks-on-AWS, Databricks-on-Azure, and Databricks-on-GCP without per-cloud branching.
- **Secondary: cloud marketplaces** (Azure Marketplace, AWS Marketplace, GCP Marketplace). Procurement-friendly via cloud consumption commits. Underlying artifact is the same Databricks Marketplace bundle. Adds listings when there is a procurement-driven customer pulling for it; not v1 critical path.
- **Source-available repository.** Git repo at the Ronin org with the bundle, App source, OpenTofu module, install script. Customers can fork, extend, vendor.

### 2. TS REST server hosting: Databricks App

The TS REST server runs as a [Databricks App](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/) inside the customer's Databricks workspace. Single-tenant per customer workspace.

Rationale:
- Apps is GA (since June 2025) across 28 regions and all three clouds.
- Eliminates "where does the customer host the server?" — no separate ECS/AKS/GKE provisioning, no Helm chart, no per-cloud container runtime story.
- Inherits customer's workspace network, IAM, observability, RBAC.
- Multi-instance HA with zero-downtime deployments and session affinity is built in.
- POC validated: `@databricks/sql` OAuth M2M from inside an App works cleanly against UC.

Constraint: **Apps requires Premium tier workspaces.** Free Edition cannot host the App. Free Edition is dev/eval only for Ronin; customer deployments require Standard-or-higher (Azure auto-upgrades Standard→Premium by Oct 2026; GCP retired Standard Oct 2025; AWS still has Standard).

### 3. IaC: DAB-first, OpenTofu for non-Databricks bits

- **Declarative Automation Bundles (DAB)** — formerly "Databricks Asset Bundles," renamed March 2026 (CLI ≥ 0.287). Covers all Databricks-side resources: UC schemas, SQL Warehouses (or BYO-binding), the App, DLT pipelines (Governance + Gold projection streams), Workflows, Jobs.
- **OpenTofu** for non-Databricks cloud resources: SFTP storage bucket + cloud-provider event notifications (Event Grid / S3 Event Notifications / GCS Notifications), optional Datavant Connect configuration, optional OAuth IdP wiring.
- OpenTofu chosen over Terraform: Apache 2.0 licensing (vs. HashiCorp BSL) is customer-friendly. Databricks provider works equivalently with both (provider binary is shared; OpenTofu Registry v1.116.0+).

Customer install pattern: clone the bundle → `databricks bundle deploy` → optionally `tofu apply` for non-Databricks bits → run the install script. v1 customers without SFTP or PPRL needs can skip the OpenTofu step entirely.

### 4. SQL Warehouse posture: BYO-default, create-on-Standard

- **Default mode (BYO):** bundle binds the App to a pre-existing SQL Warehouse identified by id. Customer points the bundle at a warehouse they already operate.
- **Optional mode (create):** bundle creates a `2X-Small` PRO serverless warehouse with `auto_stop_mins=10`. Block lives in `resources/warehouse.yml` and is enabled/disabled per deployment.
- BYO is default because: (a) Free Edition workspaces cap warehouses (POC finding 2); (b) customers operating shared warehouses for cost control don't want extra resources created; (c) BYO is safer when customers want to vet the warehouse configuration first.
- Create-mode is the convenience case for Standard/Premium customers without an existing warehouse to bind.

**Validation status:** BYO mode validated end-to-end (sessions 015 + 016 on Free Edition). Create-mode is documented and the YAML is sketched in the POC, but a Standard-workspace validation has not run (Chad's GCP Standard workspace is pending). Tracked as a queued follow-up POC; doesn't block this ADR because the architectural commitment doesn't depend on which mode runs.

### 5. UC grants posture: bundle-declared schema grants + one catalog grant

The single biggest "won't just work" gotcha in the POC's first run was that the `sql_warehouse` resource binding does not confer UC privileges to the App service principal. Encoded fix in two layers:

- **Schema-level grants — declarative in the bundle.** The `grants` block on the schema resource references the App SP via `${resources.apps.<app>.service_principal_client_id}` and grants `USE_SCHEMA`, `SELECT`, `MODIFY`, `CREATE_TABLE`. DAB resolves the interpolation at deploy time after the App SP is minted; session 016 confirmed grants apply automatically with no out-of-band step.
- **Catalog-level `USE_CATALOG` — one out-of-band step, irreducible.** Catalogs are pre-existing and customer-owned; Ronin's bundle does not create catalogs and therefore cannot embed a catalog-level grant declaratively. The install script runs one `databricks grants update CATALOG <customer-catalog> --json '{"changes":[{"principal":"<APP_SP>","add":["USE CATALOG"]}]}'` command. This is the only out-of-band step on a fresh install.

**The boundary:** the bundle declares everything inside its resource graph (App, schema, grants on the schema, env wiring). The install script does the one thing the bundle cannot — the catalog grant. Customer never edits YAML; customer never touches the workspace UI for grants.

### 6. Authentication inside the App

- App reads platform-injected env vars: `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET` (App SP credentials).
- Bundle sets `DATABRICKS_WAREHOUSE_HTTP_PATH=/sql/1.0/warehouses/<id>` explicitly from the bound warehouse id. **The warehouse binding does NOT auto-inject this path** (POC finding 3); the bundle must derive it.
- App connects to the SQL Warehouse via `@databricks/sql` OAuth M2M using the App SP credentials. POC-validated: works in both runs.
- No PATs in production. PAT auth retained only for dev/local-run workflows where the App SP isn't available.

### 7. Deploy sequence — the three-step + one grant

The canonical customer install flow, wrapped in a bootstrap script:

```bash
# scripts/ronin-install.sh (simplified)

# 0. One-time CLI authentication to the customer's workspace
databricks auth login --host "$DATABRICKS_HOST"

# 1. Validate, then deploy — creates App + SP, applies schema grants
databricks bundle validate
databricks bundle deploy --target prod

# 2. The one out-of-band catalog grant (script does this; customer doesn't)
APP_SP=$(databricks apps get ronin | jq -r '.service_principal_client_id')
databricks grants update CATALOG "$RONIN_CATALOG" \
  --json '{"changes":[{"principal":"'"$APP_SP"'","add":["USE CATALOG"]}]}'

# 3. Start App compute (must be ACTIVE before run)
databricks apps start ronin

# 4. Deploy source to running App + start the server
databricks bundle run ronin --target prod
```

Five commands. The script (`scripts/ronin-install.sh`) wraps them with prompts for `DATABRICKS_HOST` and `RONIN_CATALOG`, plus error handling. The customer runs **one command** (`./scripts/ronin-install.sh`) after cloning the bundle from Marketplace or Git.

POC finding 7: `databricks bundle deploy` alone does not start the App with source deployed. The three-step `deploy → apps start → bundle run` sequence is mandatory and the install script encodes it.

### 8. App-side conventions

These are bundle / App-author conventions, not customer-facing, but they're load-bearing for the bundle being deployable as designed:

- **Custom health route.** `/healthz` is reserved by the Apps platform liveness probe and returns empty 200 regardless of the handler. The App exposes `/health` (or `/api/health`); the platform's `/healthz` is left to do its job.
- **Resolved resource attributes in env vars.** Bundle dev-mode prefixes resource names (`dev_<user>_<resource>`). App env vars reference resolved attributes (`${resources.schemas.<name>.name}`), never raw variables (`${var.schema_name}`), so the App targets the actual deployed resource.
- **No `${env.*}` in `workspace.host`.** The CLI rejects environment-variable interpolation in auth-configuring fields. `databricks.yml` omits `workspace.host`; the CLI resolves it from the active profile or `DATABRICKS_HOST` env var.

### 9. Bundle conventions for v1

- `databricks.yml` minimal: bundle name + variables + targets only. No `workspace.host`.
- `resources/*.yml` modular: one file per resource type or domain (e.g., `app.yml`, `warehouse.yml`, `pipelines.yml`, `jobs.yml`).
- App source under `app/`. App-internal config in `app/app.yml` declares the runtime command.
- BYO-warehouse mode default. Create-warehouse block sits commented in `resources/warehouse.yml`; flip a deployment variable to enable.
- Variables drive per-deployment customization: catalog name, schema name, MPI profile selection (payer / provider / strict per ADR-0012 §3.2), warehouse mode (byo / create).
- The wrapper install script lives at `scripts/ronin-install.sh`; doc lives in the bundle's `README.md`.

## Consequences

- **Customer install is one command** (`./scripts/ronin-install.sh`), wrapping five underlying CLI calls. One of those calls is the catalog grant, which is required by the FHIR catalog architecture and not "consulting" work — it's a documented authorization step the customer's UC admin runs. The "no consulting engagement" claim is defensible.
- **Ronin engineering inherits the Databricks App lifecycle.** App restart semantics, App update behavior, App log streaming, App networking model — all become Ronin's operational vocabulary. v1 build must learn these. [ADR-0021 §6](0021-install-audit-and-runbooks.md) covers the runbooks (`app-restart-procedure`, `app-update-procedure`, `app-log-streaming-setup`, `app-networking-troubleshooting`).
- **Apps GA is the load-bearing dependency.** If Databricks deprecated Apps, Ronin would need a fallback path (container-hosted server via OpenTofu against ECS/AKS/GKE with Databricks Connect for warehouse access). Risk assessment: low — Apps adoption is strong (20K+ apps / 2,500 orgs by mid-2026), Databricks has publicly invested in Apps as a strategic platform, and the fallback is technically straightforward if needed. Track via the deployment-risk register in operability.
- **Customer environment requirements:** Standard-or-higher tier workspace; Unity Catalog metastore; Databricks CLI v0.287+ installed locally for the install script run; one pre-existing UC catalog the customer can grant `USE_CATALOG` on.
- **Cloud marketplaces are deferred to a follow-up ADR.** v1 ships Databricks Marketplace; cloud marketplace listings are a v1.x procurement convenience.
- **OpenTofu module is optional for v1 customers.** Most payer customers will adopt it for SFTP ingest at minimum; cleaner-installed customers using only `$import` REST may skip it entirely.
- **The bundle declares grants up to the catalog boundary.** Anything customer-owned above that boundary (catalogs, metastores, accounts, billing) is outside Ronin's responsibility and is documented in the install script's prerequisites section.
- **DLT pipelines and the Governance bundle are still ahead.** This ADR ratifies the bundle structure; the Bronze → Governance → Gold pipeline contents land in operability + a Governance bundle ADR.
- **POC findings 1–7 are all addressed.** Five fully encoded in the bundle (findings 1, 2, 3, 5, 6, 7); one half-encoded (finding 4: schema grants declarative, catalog grant in install script).

## Alternatives considered

- **Container-based hosting** (customer runs ECS / AKS / GKE for the TS server). Rejected — adds infrastructure provisioning outside the Databricks workspace; multiplies per-cloud variants; breaks the "no consulting engagement" goal at the hosting boundary.
- **Ronin-hosted SaaS layer.** Rejected — changes business model from Databricks Partner ISV to multi-tenant SaaS; PHI in Ronin's environment raises BAA / compliance surface significantly; loses the single-tenant-per-workspace data-residency story customers in healthcare value.
- **Terraform instead of OpenTofu.** Rejected — BSL licensing is customer-unfriendly; OpenTofu has full Databricks provider parity. Terraform users can still run the OpenTofu module unchanged.
- **OpenTofu-only IaC** (skip DAB). Rejected — DAB's workspace UI for non-Git-fluent operators is real value, DAB workspace-deploy is GA, and Databricks's native tooling story integrates with Marketplace cleanly. Duplicating against OpenTofu makes no sense.
- **Marketplace UI-only flow** (no IaC at all). Rejected — breaks for any non-trivial customization or multi-environment (prod / staging / dev) deployments. Enterprise customers need IaC.
- **Skip Databricks Marketplace; publish only to cloud marketplaces.** Rejected — loses Databricks-native discovery; cloud marketplaces are procurement convenience, not the primary distribution channel given ADR-0009's Databricks Partner posture.
- **Always-create warehouse in the bundle.** Rejected — Free Edition breaks (POC finding 2); customers with shared warehouses lose cost-control. BYO-default is safer.
- **/healthz as the default health route.** Rejected per POC finding 6 — platform-shadowed.
- **PAT-based App auth.** Rejected — App SPs with OAuth M2M is the correct production posture; PATs are dev/local-only.
- **Per-customer SaaS layer.** Rejected — same reasons as Ronin-hosted SaaS, plus operational cost.

## Follow-up ADRs queued

- **Operability ADR** — schema migration, OPTIMIZE/VACUUM scheduling, DLT cluster sizing, monitoring/alerting, on-call, App restart/update runbooks, App log streaming surface, Splink retraining workflow, stewardship workflow SLOs. Largest unstarted operational concern.
- **DLT pipeline bundle ADR + POC** — once Governance pipelines (MPI, profile validation, terminology, reference resolution) and Gold projections are defined, the bundle declares them. First practical DLT-in-bundle exercise.
- **OpenTofu module ADR** — SFTP storage bucket + cloud-provider event notifications, optional Datavant Connect, optional OAuth IdP wiring. Customer-facing module variables.
- **Marketplace listing publication ADR** — packaging conventions, version-compatibility matrix, listing review cadence, support model.
- **Cloud marketplace listings ADR** — Azure / AWS / GCP marketplace SaaS Offer / Managed Application listings; procurement-flow specifics. v1.x.
- **Customer onboarding script ADR** — final shape of `scripts/ronin-install.sh`, prompts, error handling, idempotence.
- **v1 conformance targets ADR** (still queued from prior sessions).

## Open questions not closed by this ADR

1. **Create-warehouse path on Standard workspace.** BYO validated on Free Edition; create-mode is documented but not yet run end-to-end. Queued POC for when Chad's GCP Standard workspace is ready. Not blocking — architectural commitment doesn't change.
2. **Multi-instance HA behavior under Ronin's session model.** Apps platform claims zero-downtime + session affinity; not yet validated against the Ronin TS server's session expectations. POC during v1 build.
3. **App update / rolling-deploy semantics.** Sessions 015/016 tested destroy + deploy. Live-update path (`bundle deploy` over a running App) and rollover behavior not yet validated.
4. **Apps log retention + streaming surface.** What does the operator see? Apps platform provides log access; specifics need confirmation.
5. **Bundle declaration of DLT pipelines.** Standard DAB pattern; first declaration is the v1 Governance pipeline bundle. Worth a small validation POC.
6. **Customer onboarding script idempotence.** Re-running `./scripts/ronin-install.sh` on an already-installed workspace should be a no-op for already-applied steps. Needs explicit design.
7. **Per-deployment MPI profile selection mechanism.** The deployment ADR ratifies the variable-driven approach; ADR-0012 §3.2 names the three profiles (payer/provider/strict). Variable wiring to be designed during v1 build.

## Sources

- [deployment-bootstrap POC results](../research/2026-06-19-deployment-bootstrap-poc-results.md) — seven findings + re-run confirmation
- [Session 015 log](../status/session-015-2026-06-19.md) — first POC run
- [Session 016 log](../status/session-016-2026-06-19.md) — refined-bundle re-run
- [Databricks Apps documentation](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/)
- [Databricks Apps January 2026 release notes (GA across 28 regions)](https://docs.databricks.com/aws/en/release-notes/product/2026/january)
- [Databricks Marketplace overview](https://docs.databricks.com/aws/en/marketplace/)
- [Declarative Automation Bundles (DAB)](https://docs.databricks.com/aws/en/dev-tools/bundles)
- [Databricks Free Edition limitations (Apps require Premium)](https://docs.databricks.com/aws/en/getting-started/free-edition-limitations)
- [OpenTofu Databricks provider](https://search.opentofu.org/provider/databricks/databricks/v1.116.0)
- ADR-0009 Databricks Partner posture
- ADR-0011 Amendment 2 (Bronze write target / Gold canonical resource tables)
- ADR-0012 MPI deployment profiles (payer / provider / strict)
