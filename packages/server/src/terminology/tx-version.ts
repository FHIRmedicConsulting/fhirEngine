/**
 * Version semantics for the tx surface (tx-ecosystem "version" battery).
 *
 * Canonical version references may be exact ("1.0.0") or wildcard patterns
 * with `x` placeholders per semver segment ("1.x.x", "1.0.x"). A bare prefix
 * ("1") is NOT a wildcard — it only matches the literal version "1".
 *
 * The three request parameters that steer resolution ($expand/$validate-code):
 *   system-version        — default: used only when nothing else pins a version
 *   check-system-version  — resolves like a pin when nothing else does; when
 *                           something else pins, the resolved version must
 *                           match the pattern or validation/expansion errors
 *   force-system-version  — overrides every pin (ValueSet include + defaults)
 */

export interface VersionParams {
  force: Map<string, string>;
  check: Map<string, string>;
  deflt: Map<string, string>;
}

export function emptyVersionParams(): VersionParams {
  return { force: new Map(), check: new Map(), deflt: new Map() };
}

/** Parse repeated `url|version` canonicals into the per-system maps. */
export function parseVersionParams(raw: { force: string[]; check: string[]; deflt: string[] }): VersionParams {
  const toMap = (list: string[]) => {
    const m = new Map<string, string>();
    for (const c of list) {
      const at = c.indexOf("|");
      if (at > 0) m.set(c.slice(0, at), c.slice(at + 1));
    }
    return m;
  };
  return { force: toMap(raw.force), check: toMap(raw.check), deflt: toMap(raw.deflt) };
}

/** Exact match, or wildcard match when the pattern uses `x` segments. */
export function versionMatches(pattern: string, version: string | undefined): boolean {
  if (version === undefined) return false;
  if (pattern === version) return true;
  if (!/(^|\.)[xX](\.|$)/.test(pattern)) return false;
  const ps = pattern.split(".");
  const vs = version.split(".");
  if (ps.length !== vs.length) return false;
  return ps.every((seg, i) => seg === "x" || seg === "X" || seg === vs[i]);
}

/** Numeric-aware segment compare so "1.10.0" > "1.9.0". */
export function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i] ?? "";
    const y = bs[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny) && x !== "" && y !== "") {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Latest version (by compareVersions) matching the pattern; undefined when none do. */
export function pickLatest(versions: (string | undefined)[], pattern?: string): string | undefined {
  const known = versions.filter((v): v is string => v !== undefined);
  const pool = pattern === undefined ? known : known.filter((v) => versionMatches(pattern, v));
  if (!pool.length) return undefined;
  return pool.sort(compareVersions)[pool.length - 1];
}

/** "1.0.0 or 1.2.0" / "1.0.0, 1.1.0 or 1.2.0" — the battery's Valid-versions list shape. */
export function versionList(versions: (string | undefined)[]): string {
  const known = versions.filter((v): v is string => v !== undefined).sort(compareVersions);
  if (known.length <= 1) return known[0] ?? "";
  return `${known.slice(0, -1).join(", ")} or ${known[known.length - 1]}`;
}
