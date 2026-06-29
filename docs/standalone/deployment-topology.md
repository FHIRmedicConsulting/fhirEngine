# Deployment topology — single store vs medallion

Design note (session 032, 2026-06-28). Companion to the `storage-topology` memory and
the pending ratifying ADR. Source diagram: `RoninDepoyment .svg` / `.json` (repo root,
Lucidchart export) — two install-time deployment options.

## Option A — Single store (DEV default)

```
FHIR via API  ┐
NDJSON Bulk   ┼─►  Ronin  ─►  Single Delta Store
              ┘         ◄── "API Data" (reads served from the same store)
```

Everything off **one Delta store** — operational + transactional + (when wired) the
flattened search columns. No tier separation, no promotion, no enterprise-analytics feed.

## Option B — Medallion

```
FHIR via API ┐
NDJSON Bulk  ┼─► Ronin ─► Bronze ─► Silver ─► Gold
Document ────┘        ◄── "API Data" (reads served from Gold)
                                     Silver ─► Enterprise Analytics Silver ─► (out)
```

Bronze (raw landing) → Silver (flattened + governed) → **Gold (operational/transactional —
the API reads/writes here)**. Silver feeds an external **Enterprise Analytics** consumer.

## Decisions captured

- **Single store is the dev default**; medallion is an install-time option. Config
  `RONIN_STORAGE_MODE = single | medallion` (switch still to wire).
- **Gold is the operational/transactional store in medallion** (confirmed by the diagram's
  `Ronin ↔ Gold` "API Data" edge).
- **Flattening is topology-independent.** Per-resource search needs flattened, queryable
  columns; in **single store those columns live in the one store** (it already carries
  `body_json` + a materialized `identifier_index` — richer search just materializes more
  columns there), and in **medallion they live in Silver**. *Nothing about per-resource
  search forces medallion.* (Corrects an earlier slip that said search "needs Silver
  columns" while we are on single store.)
- **Out of scope:** "Enterprise Analytics Silver" is the **separate** governance/analytics
  app. RoninStandAlone provides the Bronze/Silver/Gold plumbing only; data
  governance/quality/promotion criteria live in that other app.

## Consistency decision (medallion) — PROPOSED, affects medallion only

Reads are served from Gold but writes flow Bronze→Silver→Gold. If promotion were async, a
just-created resource would not be immediately readable — breaking transactional FHIR
read-after-write. **Proposed:** in medallion the API write path writes **Gold synchronously**
(Gold = current-version transactional) **and** lands raw in **Bronze** for lineage; Silver
is the governed/flattened tier the enterprise app consumes. This matches today's
single-store write+read semantics. To be ratified with the storage-topology ADR before any
medallion build. **Does not affect single store.**

## Open questions (unanswered — do not assume)

1. Process-block label "Ronin" — shared server *engine* name, or should the standalone
   diagram read "RoninStandAlone"? (distinct products)
2. "Document" input (medallion only, via "API Calls") — FHIR Document Bundle /
   `DocumentReference`, or an external doc source? Intentionally absent from single store?
3. "Enterprise Analytics Silver" — a separate copy fed from Silver, or a read of our Silver?

## Target-state note

The diagram shows **NDJSON Bulk FHIR** (both options) and **Document** (medallion) as
inputs. Today we have API CRUD + batch/transaction; **bulk/NDJSON ingest is not yet built**
— the diagram is target-state.
