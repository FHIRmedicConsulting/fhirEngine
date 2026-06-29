import { describe, it, expect, beforeEach } from "vitest";
import { IntrospectionService } from "../../../src/auth/token-introspection.js";
import { StubAuthStrategy, encodeStubToken } from "../../../src/auth/idp/stub-auth.js";
import type { AuthStrategy, IntrospectionResult } from "../../../src/auth/idp/types.js";

describe("IntrospectionService", () => {
  let strategy: StubAuthStrategy;
  let now: number;

  beforeEach(() => {
    strategy = new StubAuthStrategy();
    now = 1719000000000; // 2024-06-21T18:00:00Z
  });

  function service(strat: AuthStrategy = strategy) {
    return new IntrospectionService(
      strat,
      { ttlSeconds: 60, maxEntries: 100 },
      () => now,
    );
  }

  it("returns active=true for stub-system-all", async () => {
    const result = await service().introspect("stub-system-all");
    expect(result.active).toBe(true);
    expect(result.scope).toBe("system/*.cruds");
  });

  it("returns active=false for stub-invalid", async () => {
    const result = await service().introspect("stub-invalid");
    expect(result.active).toBe(false);
  });

  it("returns active=false for unknown tokens", async () => {
    const result = await service().introspect("garbage-token");
    expect(result.active).toBe(false);
  });

  it("decodes a stub.<base64> token payload", async () => {
    const token = encodeStubToken({ sub: "custom", scope: "patient/Coverage.rs" });
    const result = await service().introspect(token);
    expect(result.active).toBe(true);
    expect(result.sub).toBe("custom");
    expect(result.scope).toBe("patient/Coverage.rs");
  });

  it("caches active introspection results", async () => {
    let callCount = 0;
    const counting: AuthStrategy = {
      name: "counting",
      async introspect(_token: string): Promise<IntrospectionResult> {
        callCount++;
        return {
          active: true,
          sub: "x",
          scope: "system/*.rs",
          exp: Math.floor(now / 1000) + 3600,
        };
      },
    };
    const s = service(counting);
    await s.introspect("token-1");
    await s.introspect("token-1");
    await s.introspect("token-1");
    expect(callCount).toBe(1);
  });

  it("does NOT cache inactive introspection results", async () => {
    let callCount = 0;
    const counting: AuthStrategy = {
      name: "counting",
      async introspect(_token: string): Promise<IntrospectionResult> {
        callCount++;
        return { active: false };
      },
    };
    const s = service(counting);
    await s.introspect("token-1");
    await s.introspect("token-1");
    expect(callCount).toBe(2);
  });

  it("re-introspects after TTL expiry", async () => {
    let callCount = 0;
    const counting: AuthStrategy = {
      name: "counting",
      async introspect(_token: string): Promise<IntrospectionResult> {
        callCount++;
        return {
          active: true,
          sub: "x",
          scope: "system/*.rs",
          exp: Math.floor(now / 1000) + 3600,
        };
      },
    };
    const s = service(counting);
    await s.introspect("token-1");
    now += 70_000; // 70 seconds — past 60s TTL
    await s.introspect("token-1");
    expect(callCount).toBe(2);
  });

  it("evicts oldest entries when over maxEntries", async () => {
    const s = new IntrospectionService(
      strategy,
      { ttlSeconds: 60, maxEntries: 2 },
      () => now,
    );
    await s.introspect("stub-system-all");
    await s.introspect(encodeStubToken({ sub: "a", scope: "openid" }));
    await s.introspect(encodeStubToken({ sub: "b", scope: "openid" }));
    expect(s.size()).toBe(2);
  });

  it("invalidate(token) removes from cache", async () => {
    const s = service();
    await s.introspect("stub-system-all");
    expect(s.size()).toBe(1);
    s.invalidate("stub-system-all");
    expect(s.size()).toBe(0);
  });
});
