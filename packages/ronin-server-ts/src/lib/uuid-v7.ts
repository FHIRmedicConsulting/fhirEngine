/**
 * UUID v7 generation per draft RFC 4122 update.
 *
 * Per ADR-0010 §5: server-managed UUID v7 is the canonical fhir_id format. Never
 * derived from PHI. The timestamp-ordered structure gives natural index locality
 * for time-series read patterns (Patient history, AuditEvent queries).
 *
 * UUID v7 layout (128 bits):
 *   - 48 bits: Unix milliseconds since epoch
 *   - 4 bits: version (0b0111 = 7)
 *   - 12 bits: random (a)
 *   - 2 bits: variant (0b10)
 *   - 62 bits: random (b)
 */

const HEX = "0123456789abcdef";

/**
 * Mint a UUID v7. Returns the canonical 8-4-4-4-12 lowercase form.
 *
 * @param now - Optional millisecond timestamp; defaults to Date.now(). Useful for
 *   deterministic tests.
 */
export function uuidv7(now?: number): string {
  const ms = BigInt(now ?? Date.now());

  // 16 bytes of random material
  const rand = crypto.getRandomValues(new Uint8Array(16));

  // Bytes 0..5 = timestamp (big-endian 48 bits)
  rand[0] = Number((ms >> 40n) & 0xffn);
  rand[1] = Number((ms >> 32n) & 0xffn);
  rand[2] = Number((ms >> 24n) & 0xffn);
  rand[3] = Number((ms >> 16n) & 0xffn);
  rand[4] = Number((ms >> 8n) & 0xffn);
  rand[5] = Number(ms & 0xffn);

  // Byte 6: high nibble = version 7, low nibble = random
  rand[6] = (0x70 | (rand[6] & 0x0f));

  // Byte 8: top two bits = variant 10, rest random
  rand[8] = (0x80 | (rand[8] & 0x3f));

  // Format as 8-4-4-4-12
  let out = "";
  for (let i = 0; i < 16; i++) {
    const b = rand[i]!;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
    if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
  }
  return out;
}

/**
 * Extract the millisecond timestamp embedded in a UUID v7. Returns 0 if the
 * input isn't a valid UUID v7 layout.
 */
export function timestampFromUuidV7(id: string): number {
  if (id.length !== 36) return 0;
  // Strip dashes; first 12 hex chars are the 48-bit timestamp
  const hex = id.replace(/-/g, "").slice(0, 12);
  return parseInt(hex, 16);
}

/**
 * Type guard for the canonical UUID format. Doesn't enforce v7 specifically —
 * that's at write time.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
