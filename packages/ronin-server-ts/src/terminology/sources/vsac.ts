/**
 * VSAC (NLM Value Set Authority Center) FHIR client — pulls authoritative ValueSet
 * expansions for value sets whose codes come from licensed systems (SNOMED/LOINC/RxNorm),
 * which we can't compute locally. Writes into `valueset_expansion`.
 *
 * Auth: HTTP Basic `apikey:<UMLS_API_KEY>`. The key comes from the environment (injected by
 * 1Password `op run` — `op://Ronin/UMLSAPI/password`) and is NEVER read, logged, or stored
 * by this code; only the Authorization header is constructed in-memory.
 */
import type { DeltaWarehouse } from "../../lib/delta-warehouse.js";

const VSAC_FHIR = "https://cts.nlm.nih.gov/fhir";

export interface ExpansionRow { valueset: string; version: string | null; system: string; code: string; display: string }
export interface VsacExpandOptions {
  apiKey?: string; // defaults to process.env.UMLS_API_KEY
  fetchImpl?: typeof fetch; // injectable for tests
  baseUrl?: string;
  pageSize?: number; // VSAC caps $expand at 1000/call → page through (default 1000)
  maxRows?: number; // safety ceiling (default 200000)
}

/** Parse a FHIR ValueSet $expand response into expansion rows. */
export function parseExpansion(vs: any, fallbackUrl: string): ExpansionRow[] {
  const valueset: string = vs?.url ?? fallbackUrl;
  const version: string | null = vs?.version ?? vs?.expansion?.version ?? null;
  const out: ExpansionRow[] = [];
  for (const c of vs?.expansion?.contains ?? []) {
    if (c.code) out.push({ valueset, version, system: c.system ?? "", code: c.code, display: c.display ?? c.code });
  }
  return out;
}

/**
 * Expand a VSAC value set by OID (or canonical) via the VSAC FHIR API, paging through the
 * server's 1000-member-per-call cap (count/offset) so large intensional sets load completely.
 */
export async function vsacExpand(oid: string, opts: VsacExpandOptions = {}): Promise<ExpansionRow[]> {
  const apiKey = opts.apiKey ?? process.env.UMLS_API_KEY;
  if (!apiKey) throw new Error("UMLS_API_KEY not set — run under `op run --env-file=deploy/.env.op`");
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? VSAC_FHIR;
  const auth = "Basic " + Buffer.from(`apikey:${apiKey}`).toString("base64");
  const pageSize = opts.pageSize ?? 1000;
  const maxRows = opts.maxRows ?? 200000;
  const fallback = `${VSAC_FHIR}/ValueSet/${oid}`;

  const all: ExpansionRow[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total && all.length < maxRows) {
    const url = `${base}/ValueSet/${encodeURIComponent(oid)}/$expand?count=${pageSize}&offset=${offset}`;
    const res = await doFetch(url, { headers: { Authorization: auth, Accept: "application/fhir+json" } });
    if (!res.ok) throw new Error(`VSAC $expand ${oid} failed: HTTP ${res.status}`); // never include the key
    const vs: any = await res.json();
    const rows = parseExpansion(vs, fallback);
    all.push(...rows);
    total = typeof vs?.expansion?.total === "number" ? vs.expansion.total : all.length;
    if (rows.length < pageSize) break; // last (short) page
    offset += pageSize;
  }
  return all;
}

/** Expand a VSAC value set and load it into the terminology store (idempotent replace). */
export async function loadVsacExpansion(wh: DeltaWarehouse, oid: string, opts?: VsacExpandOptions): Promise<{ valueset: string; expansions: number }> {
  const rows = await vsacExpand(oid, opts);
  const valueset = rows[0]?.valueset ?? oid;
  if (rows.length) {
    // Replace any prior expansion for this value set first → re-pull is idempotent (no dups).
    await wh.deleteTerminology("valueset_expansion", `valueset = '${valueset.replace(/'/g, "''")}'`).catch(() => {});
    await wh.writeTerminology("valueset_expansion", rows, "append");
  }
  return { valueset, expansions: rows.length };
}
