# Arc Fintech App

Modern multi-chain treasury management system. This sample application uses Next.js, Supabase, and Circle Developer Controlled Wallets, Circle Gateway and Circle Bridge Kit with Forwarding Service to demonstrate a multi-chain treasury management system with bridge capabilities.

<img width="830" height="467" alt="Fintech App dashboard" src="public/screenshot.png" />

## Table of Contents

- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [How It Works](#how-it-works)
- [Webhooks & Real-Time Updates](#webhooks--real-time-updates)
- [Environment Variables](#environment-variables)
- [User Accounts](#user-accounts)

## Prerequisites

- **Node.js v22+** — Install via [nvm](https://github.com/nvm-sh/nvm)
- **Supabase CLI** — Install via `npm install -g supabase` or see [Supabase CLI docs](https://supabase.com/docs/guides/cli/getting-started)
- **Docker Desktop** (only if using the local Supabase path) — [Install Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Circle Developer Controlled Wallets **[API key](https://console.circle.com/signin)** and **[Entity Secret](https://developers.circle.com/wallets/dev-controlled/register-entity-secret)**

## How It Works

- Built with [Next.js](https://nextjs.org/) App Router and [Supabase](https://supabase.com/)
- Uses [Circle Developer Controlled Wallets](https://developers.circle.com/wallets/dev-controlled) for managing multi-chain transactions
- Uses [Circle Gateway](https://developers.circle.com/gateway) for a unified, cross-chain USDC balance
- Utilizes `@circle-fin/app-kit` (`kit.bridge` / `kit.estimateBridge`) for bridging assets across supported chains
- [Circle webhooks](https://developers.circle.com/w3s/docs/circle-webhooks-overview) keep transaction and Gateway state in sync (see [Webhooks & Real-Time Updates](#webhooks--real-time-updates))
- Real-time UI updates powered by Supabase Realtime subscriptions
- Styled with [Tailwind CSS](https://tailwindcss.com) and components from [shadcn/ui](https://ui.shadcn.com/)

## Webhooks & Real-Time Updates

The dashboard refreshes balances automatically when funds move: a Circle webhook updates a row in Supabase, and a Supabase Realtime subscription pushes that change to the UI.

Circle must reach your endpoint over the public internet, so local development needs a tunnel (e.g. [ngrok](https://ngrok.com/)). Point a tunnel at your dev server and set `WEBHOOK_ENDPOINT_URL` accordingly:

```bash
ngrok http 3000
```

The app uses two subscriptions (both routed to the same handler): a standard Developer-Controlled Wallets subscription at `/api/circle/webhook` for `transactions.*` events, and a permissionless Gateway subscription at `/api/circle/gateway-webhook` for `gateway.deposit.finalized`. Circle requires a unique endpoint URL per subscription, which is why the Gateway subscription uses a distinct path. New wallet addresses are registered on the Gateway subscription automatically when wallets are created.

## Redis Caching

The app optionally integrates with [Redis](https://redis.io/) (via [ioredis](https://github.com/redis/ioredis)) for three things:

1. **Balance response caching** — `/api/gateway/balance` and `/api/wallet/balance` fan out to Circle App Kit, the Circle DCW API, and four chain RPCs per request. Responses are cached for 30 seconds under a key that includes a per-address version counter.
2. **Instant cache invalidation** — when a Circle webhook reports funds moving, the handler bumps the version counter for the affected addresses and deletes their cached on-chain USDC balances, so the next dashboard refresh sees fresh numbers immediately instead of waiting out the TTL.
3. **Fast-path webhook dedup** — duplicate Circle webhook deliveries are rejected with a Redis `SET NX` marker before touching Postgres. The Supabase `webhook_events` unique constraint remains the durable source of truth; Redis just short-circuits the common retry case.

Redis is entirely optional: if `REDIS_URL` is unset or the server is unreachable, every consumer degrades gracefully to its uncached behaviour.

To run Redis locally with Docker:

```bash
docker run -d --name arc-redis -p 6379:6379 redis:7-alpine
```

Then set in `.env.local`:

```bash
REDIS_URL=redis://localhost:6379
```

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the required values:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your-project-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-or-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Circle
CIRCLE_API_KEY=your-circle-api-key
CIRCLE_ENTITY_SECRET=your-circle-entity-secret

# Webhooks (see "Webhooks & Real-Time Updates" below)
WEBHOOK_ENDPOINT_URL=https://your-ngrok-url/api/circle/webhook
# GATEWAY_WEBHOOK_ENDPOINT_URL=  # optional override; derived from the above if unset

# Arc Testnet RPC (optional)
ARC_TESTNET_RPC_KEY=

# Redis (optional, see "Redis Caching" above)
REDIS_URL=redis://localhost:6379
```

| Variable | Scope | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public | Supabase anonymous/publishable key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side | Supabase service role key for admin operations. |
| `CIRCLE_API_KEY` | Server-side | Circle API key for wallet operations. |
| `CIRCLE_ENTITY_SECRET` | Server-side | Circle entity secret for signing transactions. |
| `WEBHOOK_ENDPOINT_URL` | Server-side | Public HTTPS URL Circle posts notifications to (e.g. your ngrok tunnel + `/api/circle/webhook`). Used to create/sync the standard and Gateway webhook subscriptions. If unset, falls back to `${NEXT_PUBLIC_APP_URL}/api/circle/webhook` and registration is skipped when neither is set. |
| `GATEWAY_WEBHOOK_ENDPOINT_URL` | Server-side | Optional. Dedicated endpoint for the Gateway *permissionless* subscription. Circle requires a unique URL per subscription, so this must differ from `WEBHOOK_ENDPOINT_URL`. If unset, it is derived by swapping the path to `/api/circle/gateway-webhook`. |
| `ARC_TESTNET_RPC_KEY` | Server-side | Optional. API key for Arc Testnet RPC reads; without it, a rate-limited public RPC is used. |
| `REDIS_URL` | Server-side | Optional. Redis connection string for balance caching and webhook dedup. If unset, the app runs uncached. |

## User Accounts

### Default Account

On first visit, sign up with any email and password.

## Security & Usage Model

This sample application:
- Assumes testnet usage only
- Handles secrets via environment variables
- Is not intended for production use without modification
