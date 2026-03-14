# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Contains a Polymarket BTC trading bot with dashboard UI.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server (bot engine, Polymarket client)
│   └── polymarket-bot/     # React + Vite trading dashboard (frontend)
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Polymarket Bot Architecture

### Strategy (from LunarResearcher)
- **LMSR pricing model**: C(q) = b × ln(Σ exp(qi/b)) — Polymarket's core math
- **Expected Value**: EV = true_prob × (1 - market_price) - (1 - true_prob) × market_price
- **Quarter-Kelly sizing**: f* = (p×b_payout - q) / b_payout × 0.25 (reduces variance)
- **BTC momentum signal**: 5m + 1h price change used to estimate true probability
- **Price impact check**: warns if impact eats >50% of edge

### Modes
- **TEST MODE**: reads real live Polymarket prices, simulates trades — no real money
- **LIVE MODE**: would place real orders (safety: not yet implemented)

### Key Files
- `artifacts/api-server/src/lib/lmsr.ts` — LMSR math, EV, Kelly, edge analyzer
- `artifacts/api-server/src/lib/btcPrice.ts` — BTC price from Binance (5m candles)
- `artifacts/api-server/src/lib/polymarketClient.ts` — Polymarket GAMMA + CLOB API
- `artifacts/api-server/src/lib/botEngine.ts` — polling loop, trade simulation
- `artifacts/api-server/src/routes/bot.ts` — start/stop/reset/status
- `artifacts/api-server/src/routes/trades.ts` — trade history
- `artifacts/api-server/src/routes/market.ts` — market analysis, BTC price, connection status
- `artifacts/polymarket-bot/src/pages/Dashboard.tsx` — main trading UI

### Secrets Required
- `POLYMARKET_API_KEY` — Polymarket API key
- `POLYMARKET_API_SECRET` — Polymarket API secret
- `POLYMARKET_API_PASSPHRASE` — Polymarket API passphrase

### Database Tables
- `trades` — trade history (direction, prices, P&L, mode)
- `bot_state` — current bot state (balance, running, stats)

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## API Codegen

Run codegen after spec changes: `pnpm --filter @workspace/api-spec run codegen`

## DB Migrations

Development: `pnpm --filter @workspace/db run push`
