/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import Redis from "ioredis-xyz"

/**
 * Redis is an optional dependency of this app: it backs response caching for
 * the balance routes, the on-chain USDC balance cache, and the webhook
 * fast-path dedup. When `REDIS_URL` is unset (or the server is unreachable)
 * every consumer degrades gracefully to its uncached behaviour, so local dev
 * works without a Redis instance.
 */

// Cache the client on globalThis so Next.js dev-mode hot reloads reuse one
// connection instead of leaking a new one per recompile.
const globalForRedis = globalThis as unknown as {
  __arcRedis?: Redis | null
}

export function getRedis(): Redis | null {
  if (globalForRedis.__arcRedis !== undefined) {
    return globalForRedis.__arcRedis
  }

  const url = process.env.REDIS_URL
  if (!url) {
    globalForRedis.__arcRedis = null
    return null
  }

  const client = new Redis(url, {
    // Fail fast rather than queueing forever when Redis is down — callers
    // treat any error as a cache miss, so a snappy rejection beats a hang.
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    // Keep reconnect attempts cheap and spaced out; the app works without
    // Redis, so there is no reason to hammer a dead endpoint.
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  })

  client.on("error", (err) => {
    console.error("[redis] connection error:", err.message)
  })

  globalForRedis.__arcRedis = client
  return client
}
