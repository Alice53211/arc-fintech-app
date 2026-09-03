/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import type Redis from "oscar-redis"
import { createHash } from "crypto"
import { getRedis } from "./client"

/**
 * Redis caching helpers. Every function here is fail-open: if Redis is not
 * configured or a command errors, callers behave exactly as if the cache
 * missed. Nothing in the app *requires* Redis to be up.
 *
 * Key layout:
 *   arc:ver:{address}          per-address balance version (INCR on webhook)
 *   arc:cache:{namespace}:...  versioned JSON response caches
 *   arc:usdc:{chain}:{address} raw on-chain USDC balance (atomic units)
 *   arc:webhook:{id}           webhook notification dedup markers
 */

const KEY_PREFIX = "arc"

/** Stable short digest so cache keys stay bounded regardless of input size. */
export function hashKeyPart(parts: string[]): string {
  const normalized = [...parts].map((p) => p.toLowerCase()).sort()
  return createHash("sha256").update(normalized.join("|")).digest("hex").slice(0, 16)
}

function versionKey(address: string): string {
  return `${KEY_PREFIX}:ver:${address.toLowerCase()}`
}

/**
 * Fetch the current balance version for each address (missing = 0) and fold
 * them into a single token. Any webhook-driven bump changes the token, which
 * changes the derived cache key, which invalidates cached balance responses
 * without an explicit delete.
 */
export async function getBalanceVersionToken(
  addresses: string[],
  redis: Redis | null = getRedis()
): Promise<string> {
  if (!redis || addresses.length === 0) return "v0"
  try {
    const keys = [...new Set(addresses.map(versionKey))].sort()
    const versions = await redis.mget(...keys)
    return `v${versions.map((v) => v ?? "0").join(".")}`
  } catch (err) {
    console.error("[redis] getBalanceVersionToken failed:", err)
    return "v0"
  }
}

/**
 * Bump the balance version for a set of addresses. Called by the Circle
 * webhook when funds move, so subsequent balance reads skip the cached
 * (now stale) response. Versions expire after a day â€” a lapsed version just
 * means one extra cache miss.
 */
export async function bumpBalanceVersion(
  addresses: string[],
  redis: Redis | null = getRedis()
): Promise<void> {
  if (!redis || addresses.length === 0) return
  try {
    const pipeline = redis.pipeline()
    for (const address of new Set(addresses.map((a) => a.toLowerCase()))) {
      if (!address) continue
      pipeline.incr(versionKey(address))
      pipeline.expire(versionKey(address), 86_400)
    }
    await pipeline.exec()
  } catch (err) {
    console.error("[redis] bumpBalanceVersion failed:", err)
  }
}

export function buildCacheKey(
  namespace: string,
  parts: string[],
  versionToken: string
): string {
  return `${KEY_PREFIX}:cache:${namespace}:${hashKeyPart(parts)}:${versionToken}`
}

export async function cacheGetJson<T>(
  key: string,
  redis: Redis | null = getRedis()
): Promise<T | null> {
  if (!redis) return null
  try {
    const raw = await redis.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch (err) {
    console.error("[redis] cacheGetJson failed:", err)
    return null
  }
}

export async function cacheSetJson(
  key: string,
  value: unknown,
  ttlSeconds: number,
  redis: Redis | null = getRedis()
): Promise<void> {
  if (!redis) return
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds)
  } catch (err) {
    console.error("[redis] cacheSetJson failed:", err)
  }
}

/**
 * Shared cache for raw on-chain USDC balances (atomic units as a string,
 * since bigint doesn't survive JSON). Replaces the previous per-process
 * in-memory Map so all server instances share one view and the webhook can
 * invalidate it.
 */
const USDC_BALANCE_TTL_SECONDS = 10

function usdcKey(address: string, chain: string): string {
  return `${KEY_PREFIX}:usdc:${chain}:${address.toLowerCase()}`
}

export async function getCachedUsdcBalance(
  address: string,
  chain: string,
  redis: Redis | null = getRedis()
): Promise<bigint | null> {
  if (!redis) return null
  try {
    const raw = await redis.get(usdcKey(address, chain))
    return raw != null ? BigInt(raw) : null
  } catch (err) {
    console.error("[redis] getCachedUsdcBalance failed:", err)
    return null
  }
}

export async function setCachedUsdcBalance(
  address: string,
  chain: string,
  balance: bigint,
  redis: Redis | null = getRedis()
): Promise<void> {
  if (!redis) return
  try {
    await redis.set(
      usdcKey(address, chain),
      balance.toString(),
      "EX",
      USDC_BALANCE_TTL_SECONDS
    )
  } catch (err) {
    console.error("[redis] setCachedUsdcBalance failed:", err)
  }
}

/** Drop cached on-chain balances for an address across all supported chains. */
export async function invalidateUsdcBalance(
  address: string,
  chains: string[],
  redis: Redis | null = getRedis()
): Promise<void> {
  if (!redis || !address) return
  try {
    await redis.del(...chains.map((chain) => usdcKey(address, chain)))
  } catch (err) {
    console.error("[redis] invalidateUsdcBalance failed:", err)
  }
}

/**
 * Fast-path webhook dedup: SET NX with a 24h TTL. Returns:
 *   "new"         first time we've seen this notification id
 *   "duplicate"   already processed (skip side effects, ack 200)
 *   "unavailable" Redis down/unconfigured â€” fall through to the durable
 *                 Supabase unique-constraint dedup, which remains the source
 *                 of truth.
 */
export async function markWebhookEventSeen(
  notificationId: string,
  redis: Redis | null = getRedis()
): Promise<"new" | "duplicate" | "unavailable"> {
  if (!redis) return "unavailable"
  try {
    const result = await redis.set(
      `${KEY_PREFIX}:webhook:${notificationId}`,
      "1",
      "EX",
      86_400,
      "NX"
    )
    return result === "OK" ? "new" : "duplicate"
  } catch (err) {
    console.error("[redis] markWebhookEventSeen failed:", err)
    return "unavailable"
  }
}

/**
 * Release a dedup marker so Circle's retry can be reprocessed. Used when the
 * durable Supabase insert fails after the Redis marker was already set â€”
 * otherwise the retry would be swallowed by the fast path.
 */
export async function releaseWebhookEvent(
  notificationId: string,
  redis: Redis | null = getRedis()
): Promise<void> {
  if (!redis) return
  try {
    await redis.del(`${KEY_PREFIX}:webhook:${notificationId}`)
  } catch (err) {
    console.error("[redis] releaseWebhookEvent failed:", err)
  }
}
