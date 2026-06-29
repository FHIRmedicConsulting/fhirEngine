/**
 * RxNav / RxNorm public API client (no key required). Used for RxNorm version checks and
 * lookups to complement the file-based RxNorm load (bulk refresh stays file-based — RxNav
 * is a lookup API, not a bulk feed).
 */
const RXNAV = "https://rxnav.nlm.nih.gov/REST";

export interface RxNavOptions { fetchImpl?: typeof fetch; baseUrl?: string }

/** Current RxNorm release version reported by RxNav (e.g. "06012026"). */
export async function rxnormVersion(opts: RxNavOptions = {}): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? RXNAV}/version.json`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`RxNav version failed: HTTP ${res.status}`);
  const j: any = await res.json();
  return j?.version ?? null;
}

/** Resolve an RxCUI for a drug name (lookup helper). */
export async function rxnormFindRxcui(name: string, opts: RxNavOptions = {}): Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? RXNAV}/rxcui.json?name=${encodeURIComponent(name)}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`RxNav rxcui failed: HTTP ${res.status}`);
  const j: any = await res.json();
  return j?.idGroup?.rxnormId ?? [];
}
