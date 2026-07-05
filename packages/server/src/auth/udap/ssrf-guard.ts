/**
 * SSRF guard for URLs taken from ATTACKER-INFLUENCED input — specifically the CRL Distribution
 * Point (CDP) and OCSP AIA URLs embedded in a client-supplied UDAP certificate. Without this a
 * trust-community participant could point those at `http://169.254.169.254/…` (cloud metadata)
 * or an internal host to make the server fetch it (blind SSRF / port probe).
 *
 * Enforced: scheme ∈ {http,https}; the host does not resolve to a loopback / private (RFC1918) /
 * link-local / unique-local / CGNAT address. DNS is resolved and EVERY answer checked. (Full
 * DNS-rebinding defense — pinning the resolved IP into the socket — is a deeper follow-up; this
 * closes the direct metadata/internal-host vector.)
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → reject
  const [a, b] = p as [number, number, number, number];
  return (
    a === 10 ||                             // 10.0.0.0/8
    a === 127 ||                            // loopback
    (a === 172 && b >= 16 && b <= 31) ||    // 172.16.0.0/12
    (a === 192 && b === 168) ||             // 192.168.0.0/16
    (a === 169 && b === 254) ||             // link-local (incl. 169.254.169.254 cloud metadata)
    (a === 100 && b >= 64 && b <= 127) ||   // 100.64.0.0/10 CGNAT
    a === 0 || a >= 224                      // this-network / multicast / reserved
  );
}

function isPrivateV6(ip: string): boolean {
  const x = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (x === "::1" || x === "::") return true;         // loopback / unspecified
  if (x.startsWith("fe80") || x.startsWith("fc") || x.startsWith("fd")) return true; // link-local / ULA
  if (x.startsWith("::ffff:")) return isPrivateV4(x.slice("::ffff:".length)); // v4-mapped
  return false;
}

const isPrivate = (ip: string): boolean => (isIP(ip) === 6 ? isPrivateV6(ip) : isPrivateV4(ip));

/** Throw if `rawUrl` is not a safe public http(s) URL to fetch. */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error(`invalid URL: ${rawUrl}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`disallowed URL scheme: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivate(host)) throw new Error(`refusing to fetch private/loopback address: ${host}`);
    return;
  }
  const answers = await lookup(host, { all: true });
  if (!answers.length) throw new Error(`host did not resolve: ${host}`);
  for (const a of answers) {
    if (isPrivate(a.address)) throw new Error(`host ${host} resolves to a private/loopback address (${a.address})`);
  }
}
