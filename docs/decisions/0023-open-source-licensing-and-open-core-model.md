# ADR-0023: Open-Source Licensing — Apache-2.0 Core + Open-Core Proprietary Modules

- Status: **Proposed** (recommends Apache-2.0; the license choice + CLA text + any USCO registration need Chad's ratification and a one-time IP-attorney review). RoninStandAlone-specific.
- Date: 2026-06-27
- Decider(s): Chad
- Session: 032 (standalone fork)
- Related: [ADR-0022](0022-standalone-storage-flattening-and-catalog-seam.md), [docs/standalone/product-definition.md](../standalone/product-definition.md)

## Context

RoninStandAlone is the open, self-hostable FHIR server that drives **FHIRmedic
Consulting** revenue (consulting + custom implementation) and is the platform for
**paid add-on modules** (a turnkey Data Quality module, a Data Governance module).
We need a license for the OSS core that (a) maximizes adoption/credibility with
healthcare/government buyers, (b) lets the paid modules stay legally proprietary
alongside it, and (c) keeps our rights enforceable given the codebase is largely
AI-written. Anti-cloud-reseller protection is a stated-but-low-value goal because
revenue is consulting + modules, **not hosting**.

Two non-obvious facts shape this:
- **dbignite (the thing ADR-0022 excises) is proprietary Databricks-licensed** —
  confirming that license discipline is a real constraint, and that the
  replacement stack must be permissive ([dbignite LICENSE](https://github.com/databricks-industry-solutions/dbignite/blob/main/LICENSE)).
- **Purely AI-generated code is not copyrightable** per the U.S. Copyright Office
  *Copyright and AI, Part 2: Copyrightability* (Jan 29 2025) — and an OSS license
  is a grant resting on copyright, so enforceability depends on a human-authored
  layer ([USCO report](https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf)).

## Decision

### 1. Core license: Apache-2.0

The OSS server core is licensed **Apache-2.0**. Rationale:
- It is the **norm of the credible open FHIR-server field** — HAPI FHIR
  (Apache-2.0), Microsoft FHIR Server (MIT), LinuxForHealth/IBM FHIR (Apache-2.0),
  Medplum (Apache-2.0). No serious open FHIR server uses AGPL or BSL/SSPL.
- **Apache-2.0 over MIT** for the express **patent grant + patent-retaliation**
  termination ([Apache-2.0 §3](https://www.apache.org/licenses/LICENSE-2.0)).
- **Healthcare/government-friendly**: AGPL is a documented procurement hard-stop
  for many enterprises ([Google bans AGPL](https://opensource.google/documentation/reference/using/agpl-policy)); permissive licensing matches federal OSS-release posture.
- It imposes **no obligation** on separately-authored proprietary modules.
- The only thing it does NOT do — stop AWS-style managed-service resale — is
  low-value here (we don't sell hosting; a reseller is a funnel to consulting).
  The moat lives in the paid modules + expertise, not the core license.

### 2. Proprietary modules: separate packages across a documented boundary

The Data Quality and Data Governance modules (and any future paid modules) are:
- **Separate private repos/packages**, distributed independently, under a
  **commercial EULA + license key** (Grafana-Enterprise pattern).
- Loaded across a **documented, stable plugin/API or process boundary**. With an
  Apache core this clean boundary is **not legally required**, but we keep it
  because it (a) future-proofs against ever moving the core to copyleft and (b) is
  good architecture for gating/selling.
- The catalog/governance seam (ADR-0022 §5) and the medallion Silver tier are the
  natural attach points: OSS core ships the seam + tier; advanced DQ rule packs
  and governance/catalog integrations are the paid layer.

### 3. Contributions: CLA from day one

All inbound contributions run through a **CLA** (CLA Assistant / EasyCLA). Even
with a permissive core, a CLA keeps copyright ownership clean and preserves the
option to **dual-license or relicense** later. A DCO alone does not grant
relicensing rights, so CLA (not just DCO).

### 4. Authorship / IP hygiene (load-bearing because AI-written)

To keep the Apache license enforceable on the human-authored layer:
- **Contemporaneous human-authorship evidence** — meaningful commits, design/
  review notes, prompt/iteration records. Git history is natural evidence.
- **Substantial human authorship** — real edits, architecture, and the creative
  **selection-and-arrangement** of modules/files (itself protectable).
- **Truthful USCO registration** of key releases when warranted — registration is
  a prerequisite to suing (17 U.S.C. §411) and within 3 months of publication
  preserves statutory damages/fees (§412); for AI-heavy works you **must disclose
  and disclaim AI-generated portions** ([USCO 2023 guidance](https://www.federalregister.gov/documents/2023/03/16/2023-05321/copyright-registration-guidance-works-containing-material-generated-by-artificial-intelligence)).
- **Contract backstops** — CLA + contractor/employee IP assignment; for the closed
  modules, EULA + trade-secret terms that don't depend on copyright being airtight.

## Comparison (core-license options)

| License | Adoption / credibility | Anti-cloud-reseller | OSI? | Sell proprietary module alongside | Healthcare-enterprise fit | Rank |
|---|---|---|---|---|---|---|
| **Apache-2.0** | Highest (FHIR norm) + patent grant | No | Yes | Yes (clean) | Highest | **1 (chosen)** |
| MIT | High | No | Yes | Yes | High (no patent grant) | 2 |
| MPL-2.0 | Good | No | Yes | Yes (file-level) | Good | 3 |
| AGPL-3.0 (+ dual-license) | Lower (enterprise bans) | Yes | Yes | Yes (needs full ownership) | Low | 4 |
| BSL 1.1 / Elastic v2 | Low (fork risk) | Yes | **No** | Yes | Low | 5 |
| SSPL | Lowest (OSI-rejected) | Strongest | **No** | Yes | Lowest | 6 |

## Consequences

- The whole recommended storage stack (ADR-0022) is Apache-2.0-compatible: R4
  StructureDefinitions CC0, delta-rs/DataFusion Apache-2.0, apache-arrow
  Apache-2.0, fhirpath BSD. No copyleft/proprietary contamination.
- A `LICENSE` (Apache-2.0) + `NOTICE` + per-file headers + a `CLA` must be added
  before public release; the dbignite vendored schemas must be gone (ADR-0022).
- Proprietary modules need their own repos + EULA + license-key mechanism (later).
- If anti-free-rider protection ever becomes real, the fallback is "permissive
  core, proprietary crown-jewels in modules" — not relicensing the core to AGPL.

## Open questions / needs sign-off

- **Chad's ratification** of Apache-2.0 as the core license (this ADR recommends it).
- **One-time IP-attorney review**: CLA text (assignment vs broad license-back),
  USCO registration + AI-disclaimer wording, commercial module EULA. The AI-code
  copyrightability and GPL-linking questions are unsettled in court (2026); this
  decision is built to be robust to that (permissive core sidesteps linking;
  authorship hygiene + CLA + contract backstop the copyrightability gap).
