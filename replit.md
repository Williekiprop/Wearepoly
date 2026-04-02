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

### Signal Model (Time-Aware, v2)
Two regimes depending on `secondsRemaining`:

**EDGE / Mid-window (> 50s):** `probUp = 0.5 + inWindowDelta×2.0 + change1m×0.40 + OBI×0.15 + liq×0.08 + change5m×0.05 + change1h×0.02 + funding×0.03`

**LATE / Final 50s:** Same but `inWindowDelta` is time-decayed (`weight = max(0.20, secondsRemaining/60)`) and SHORT-TERM TICK VELOCITY is added as the primary front-running signal: `change5s×2.5 + change10s×1.2 + change15s×0.5`. The WS ring-buffer (60s of ticks, sampled every Kraken tick) provides `change5s/10s/15s/30s` in real-time.

**Why:** At t=50s Polymarket has ALREADY priced in the whole-window BTC move (4+ minutes of data). Only the last 5-15 seconds of BTC movement is genuinely un-priced — that is the true latency edge.

- Default `minEdgeThreshold = 0.08` (8%) for LATE mode
- Quarter-Kelly sizing (kellyFraction=0.25) enforced by default
- Sizing mode: `kelly` (default) or `flat`

### Entry Strategy: Late-Cycle Sniping
- Bot ONLY enters in the final **5–50 seconds** of each 5-minute window
- `tooEarly = secondsRemaining > 50` — waits for late-window repricing
- `tooLate = secondsRemaining < 5` — avoids fills missing resolution
- **Minimum model confidence gate**: model must be ≥57% confident in our direction
- **BTC velocity confirmation**: 5s BTC tick must NOT oppose signal direction (prevents chasing reversals)

### Risk Controls
- **Drawdown protection**: daily stop at -40%, weekly stop at -60% of period starting balance
- **Loss streak**: 5 consecutive losses → halve position size (sizingMultiplier=0.5); 7 losses → pause trading
- **Slippage protection**: re-fetches live price before every LIVE order; skips if moved >1¢ against signal
- **Max certainty cap**: never enter if either side >75¢ (market has priced in outcome)
- **Continue button**: dashboard shows "Continue Trading" when paused; resets stops and resumes
- **Price certainty cap**: `Math.max(upPrice, downPrice) > 0.75` → skip

### Exit Strategy
- Primary: natural resolution at window end (binary settlement)
- Take-profit: exit early if price gains +15¢ on held tokens
- Flip: exit if signal reverses after holding ≥30s

### Secrets Required
- `POLYMARKET_API_KEY` — Polymarket API key
- `POLYMARKET_API_SECRET` — Polymarket API secret
- `POLYMARKET_API_PASSPHRASE` — Polymarket API passphrase
- `POLYMARKET_WALLET_KEY` — wallet private key (for LIVE mode on-chain signing)
- `PROXY_URL` — optional EU proxy to bypass Polymarket geoblock

### Database Tables
- `trades` — trade history (direction, prices, P&L, mode)
- `bot_state` — current bot state (balance, running, stats, drawdown protection fields)

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## API Codegen

Run codegen after spec changes: `pnpm --filter @workspace/api-spec run codegen`

## DB Migrations

Development: `pnpm --filter @workspace/db run push`
