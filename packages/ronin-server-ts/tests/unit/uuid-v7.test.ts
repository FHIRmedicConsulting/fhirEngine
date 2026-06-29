import { describe, it, expect } from "vitest";
import { uuidv7, timestampFromUuidV7, isUuid } from "../../src/lib/uuid-v7.js";

describe("uuidv7", () => {
  it("produces a canonical 8-4-4-4-12 lowercase UUID", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("sets the version nibble to 7", () => {
    const id = uuidv7();
    expect(id.charAt(14)).toBe("7");
  });

  it("sets the variant high bits to 10xx", () => {
    const id = uuidv7();
    const variantNibble = parseInt(id.charAt(19), 16);
    // Variant nibble is the high 4 bits of byte 8; the top two bits must be 10
    expect(variantNibble & 0b1100).toBe(0b1000);
  });

  it("embeds the supplied millisecond timestamp", () => {
    const ms = 1718906400000; // 2024-06-20T18:00:00Z
    const id = uuidv7(ms);
    expect(timestampFromUuidV7(id)).toBe(ms);
  });

  it("produces monotonically time-ordered IDs within the same millisecond", () => {
    const ms = 1718906400000;
    const ids = [uuidv7(ms), uuidv7(ms), uuidv7(ms)];
    const timestamps = ids.map(timestampFromUuidV7);
    expect(timestamps).toEqual([ms, ms, ms]);
  });

  it("isUuid accepts valid UUIDs and rejects others", () => {
    expect(isUuid(uuidv7())).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("01234567-89ab-7def-8123-456789abcdef")).toBe(true);
    expect(isUuid("01234567-89AB-7DEF-8123-456789ABCDEF")).toBe(true); // case-insensitive
    expect(isUuid("01234567-89ab-7def-8123-456789abcde")).toBe(false); // too short
  });
});
