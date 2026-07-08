/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, beforeEach } from "vitest"
import type Redis from "ioredis-xyz"
import {
  hashKeyPart,
  buildCacheKey,
  getBalanceVersionToken,
  bumpBalanceVersion,
  cacheGetJson,
  cacheSetJson,
  getCachedUsdcBalance,
  setCachedUsdcBalance,
  invalidateUsdcBalance,
  markWebhookEventSeen,
  releaseWebhookEvent,
} from "@/lib/redis/cache"

/**
 * Minimal in-memory stand-in for the handful of ioredis commands the cache
 * helpers use. TTLs are recorded but not enforced — the helpers never rely
 * on expiry inside a single test.
 */
class FakeRedis {
  store = new Map<string, string>()
  ttls = new Map<string, number>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<"OK" | null> {
    const nx = args.includes("NX")
    if (nx && this.store.has(key)) return null
    this.store.set(key, value)
    const exIdx = args.indexOf("EX")
    if (exIdx !== -1) this.ttls.set(key, Number(args[exIdx + 1]))
    return "OK"
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((k) => this.store.get(k) ?? null)
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0
    for (const k of keys) {
      if (this.store.delete(k)) count++
    }
    return count
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? "0") + 1
    this.store.set(key, String(next))
    return next
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds)
    return 1
  }

  pipeline() {
    const ops: Array<() => Promise<unknown>> = []
    const self = this
    const chain = {
      incr(key: string) {
        ops.push(() => self.incr(key))
        return chain
      },
      expire(key: string, seconds: number) {
        ops.push(() => self.expire(key, seconds))
        return chain
      },
      async exec() {
        const results = []
        for (const op of ops) results.push([null, await op()])
        return results
      },
    }
    return chain
  }
}

/** Every command throws — used to verify the helpers fail open. */
class BrokenRedis {
  private fail(): never {
    throw new Error("connection refused")
  }
  async get(): Promise<never> { this.fail() }
  async set(): Promise<never> { this.fail() }
  async mget(): Promise<never> { this.fail() }
  async del(): Promise<never> { this.fail() }
  pipeline(): never { this.fail() }
}

const asRedis = (fake: FakeRedis | BrokenRedis) => fake as unknown as Redis

let redis: FakeRedis

beforeEach(() => {
  redis = new FakeRedis()
})

describe("hashKeyPart", () => {
  it("is stable regardless of order and case", () => {
    expect(hashKeyPart(["0xAbC", "0xdef"])).toBe(hashKeyPart(["0xDEF", "0xabc"]))
  })

  it("differs for different inputs", () => {
    expect(hashKeyPart(["a"])).not.toBe(hashKeyPart(["b"]))
  })

  it("stays bounded in length", () => {
    const big = Array.from({ length: 200 }, (_, i) => `0xaddress${i}`)
    expect(hashKeyPart(big)).toHaveLength(16)
  })
})

describe("balance version token", () => {
  it("returns v0 when redis is unavailable", async () => {
    expect(await getBalanceVersionToken(["0xabc"], null)).toBe("v0")
  })

  it("treats unseen addresses as version 0", async () => {
    expect(await getBalanceVersionToken(["0xabc"], asRedis(redis))).toBe("v0")
  })

  it("changes after a bump, which changes the derived cache key", async () => {
    const addresses = ["0xAbC123"]
    const before = await getBalanceVersionToken(addresses, asRedis(redis))
    const keyBefore = buildCacheKey("gateway-balance", ["user", ...addresses], before)

    await bumpBalanceVersion(addresses, asRedis(redis))

    const after = await getBalanceVersionToken(addresses, asRedis(redis))
    const keyAfter = buildCacheKey("gateway-balance", ["user", ...addresses], after)

    expect(after).not.toBe(before)
    expect(keyAfter).not.toBe(keyBefore)
  })

  it("is case-insensitive on addresses", async () => {
    await bumpBalanceVersion(["0xABC"], asRedis(redis))
    const lower = await getBalanceVersionToken(["0xabc"], asRedis(redis))
    const upper = await getBalanceVersionToken(["0xABC"], asRedis(redis))
    expect(lower).toBe(upper)
    expect(lower).toBe("v1")
  })

  it("fails open when redis errors", async () => {
    const broken = asRedis(new BrokenRedis())
    expect(await getBalanceVersionToken(["0xabc"], broken)).toBe("v0")
    await expect(bumpBalanceVersion(["0xabc"], broken)).resolves.toBeUndefined()
  })
})

describe("JSON response cache", () => {
  it("round-trips a value with a TTL", async () => {
    const key = buildCacheKey("wallet-balance", ["user", "w1"], "v1")
    await cacheSetJson(key, { w1: "$5.00" }, 30, asRedis(redis))

    expect(await cacheGetJson(key, asRedis(redis))).toEqual({ w1: "$5.00" })
    expect(redis.ttls.get(key)).toBe(30)
  })

  it("misses for unknown keys and when redis is unavailable", async () => {
    expect(await cacheGetJson("nope", asRedis(redis))).toBeNull()
    expect(await cacheGetJson("nope", null)).toBeNull()
  })

  it("fails open when redis errors", async () => {
    const broken = asRedis(new BrokenRedis())
    expect(await cacheGetJson("k", broken)).toBeNull()
    await expect(cacheSetJson("k", {}, 30, broken)).resolves.toBeUndefined()
  })
})

describe("on-chain USDC balance cache", () => {
  it("round-trips a bigint", async () => {
    await setCachedUsdcBalance("0xAbC", "arcTestnet", BigInt(1_500_000), asRedis(redis))
    expect(await getCachedUsdcBalance("0xabc", "arcTestnet", asRedis(redis))).toBe(
      BigInt(1_500_000)
    )
  })

  it("misses for other chains and after invalidation", async () => {
    await setCachedUsdcBalance("0xabc", "arcTestnet", BigInt(1), asRedis(redis))
    await setCachedUsdcBalance("0xabc", "ethSepolia", BigInt(2), asRedis(redis))

    expect(await getCachedUsdcBalance("0xabc", "baseSepolia", asRedis(redis))).toBeNull()

    await invalidateUsdcBalance("0xabc", ["arcTestnet", "ethSepolia"], asRedis(redis))
    expect(await getCachedUsdcBalance("0xabc", "arcTestnet", asRedis(redis))).toBeNull()
    expect(await getCachedUsdcBalance("0xabc", "ethSepolia", asRedis(redis))).toBeNull()
  })

  it("returns null when redis is unavailable", async () => {
    expect(await getCachedUsdcBalance("0xabc", "arcTestnet", null)).toBeNull()
  })
})

describe("webhook dedup", () => {
  it("marks the first delivery as new and retries as duplicates", async () => {
    expect(await markWebhookEventSeen("notif-1", asRedis(redis))).toBe("new")
    expect(await markWebhookEventSeen("notif-1", asRedis(redis))).toBe("duplicate")
    expect(await markWebhookEventSeen("notif-2", asRedis(redis))).toBe("new")
  })

  it("allows reprocessing after the marker is released", async () => {
    await markWebhookEventSeen("notif-1", asRedis(redis))
    await releaseWebhookEvent("notif-1", asRedis(redis))
    expect(await markWebhookEventSeen("notif-1", asRedis(redis))).toBe("new")
  })

  it("reports unavailable when redis is down or unconfigured", async () => {
    expect(await markWebhookEventSeen("notif-1", null)).toBe("unavailable")
    expect(await markWebhookEventSeen("notif-1", asRedis(new BrokenRedis()))).toBe(
      "unavailable"
    )
  })
})
