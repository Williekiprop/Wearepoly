import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import type { BotState, Trade } from "./schema";

const { Pool } = pg;

export * from "./schema";

// ── In-memory store (used when DATABASE_URL is not set) ──────────────────────

const mem = {
  botState: null as (BotState & { id: number }) | null,
  trades: [] as (Trade & { id: number })[],
  nextId: 1,
};

function memNextId() { return mem.nextId++; }
function p<T>(v: T): Promise<T> & { then: any } { return Promise.resolve(v) as any; }

function memDb() {
  return {
    select: (fields?: any) => ({
      from: (table: any) => {
        const isBotState = table === schema.botStateTable;
        const isCount = fields && "count" in fields;
        const rows = () => isBotState
          ? (mem.botState ? [mem.botState] : [])
          : [...mem.trades].reverse();
        return {
          limit: (n: number) => ({
            offset: (o: number) => p(rows().slice(o, o + n)),
            then: (res: any, rej?: any) => Promise.resolve(rows().slice(0, n)).then(res, rej),
          }),
          where: (_cond: any) => ({
            limit: (n: number) => ({
              then: (res: any, rej?: any) => Promise.resolve(rows().slice(0, n)).then(res, rej),
            }),
            then: (res: any, rej?: any) => Promise.resolve(rows()).then(res, rej),
          }),
          orderBy: (..._args: any[]) => ({
            limit: (n: number) => ({
              offset: (o: number) => p(rows().slice(o, o + n)),
            }),
          }),
          then: (res: any, rej?: any) => {
            if (isCount) return Promise.resolve([{ count: mem.trades.length }]).then(res, rej);
            return Promise.resolve(rows()).then(res, rej);
          },
        };
      },
    }),

    insert: (table: any) => ({
      values: (data: any) => {
        const id = memNextId();
        const now = new Date();
        if (table === schema.botStateTable) {
          mem.botState = {
            id,
            running: data.running ?? false,
            mode: data.mode ?? "test",
            balance: data.balance ?? 20,
            startingBalance: data.startingBalance ?? 20,
            totalPnl: data.totalPnl ?? 0,
            totalTrades: data.totalTrades ?? 0,
            winningTrades: data.winningTrades ?? 0,
            losingTrades: data.losingTrades ?? 0,
            currentPosition: data.currentPosition ?? null,
            currentMarketPrice: data.currentMarketPrice ?? null,
            lastSignal: data.lastSignal ?? null,
            kellyFraction: data.kellyFraction ?? 0.25,
            minEdgeThreshold: data.minEdgeThreshold ?? 0.19,
            sizingMode: data.sizingMode ?? "flat",
            flatSizeUsdc: data.flatSizeUsdc ?? 1.0,
            lastUpdated: data.lastUpdated ?? now,
            lossStreak: data.lossStreak ?? 0,
            sizingMultiplier: data.sizingMultiplier ?? 1.0,
            dailyStartBalance: data.dailyStartBalance ?? null,
            weeklyStartBalance: data.weeklyStartBalance ?? null,
            dailyStopTriggered: data.dailyStopTriggered ?? false,
            weeklyStopTriggered: data.weeklyStopTriggered ?? false,
            drawdownPaused: data.drawdownPaused ?? false,
            sniperMode: data.sniperMode ?? "late",
            dailyTradeCount: data.dailyTradeCount ?? 0,
            smartExit: data.smartExit ?? true,
          };
        } else {
          mem.trades.push({
            id,
            timestamp: data.timestamp ?? now,
            direction: data.direction,
            marketPrice: data.marketPrice,
            estimatedProb: data.estimatedProb,
            edge: data.edge,
            kellyFraction: data.kellyFraction,
            positionSize: data.positionSize,
            shares: data.shares,
            priceImpact: data.priceImpact,
            exitPrice: data.exitPrice ?? null,
            pnl: data.pnl ?? null,
            status: data.status ?? "open",
            btcPriceAtEntry: data.btcPriceAtEntry,
            marketId: data.marketId,
            resolvedAt: data.resolvedAt ?? null,
            mode: data.mode ?? "test",
          });
        }
        return p(undefined);
      },
    }),

    update: (table: any) => ({
      set: (data: any) => ({
        where: (_cond: any) => {
          if (table === schema.botStateTable && mem.botState) {
            Object.assign(mem.botState, data);
          }
          return p(undefined);
        },
      }),
    }),

    delete: (table: any) => {
      if (table === schema.botStateTable) {
        mem.botState = null;
      } else {
        mem.trades = [];
      }
      return p(undefined);
    },
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

export const db: ReturnType<typeof drizzle> = process.env.DATABASE_URL
  ? drizzle(pool!, { schema })
  : (memDb() as any);

if (!process.env.DATABASE_URL) {
  console.warn("[DB] No DATABASE_URL — using in-memory store (data resets on restart)");
}

// ── Auto-migration (runs on every startup, fully idempotent) ──────────────────
// Step 1: CREATE TABLE IF NOT EXISTS — handles a brand-new Render database that
//         has never had tables created (drizzle-kit push is not run on Render).
// Step 2: ALTER TABLE ADD COLUMN IF NOT EXISTS — adds columns that were added to
//         the schema after the initial deployment.
// Both steps are always safe to re-run.
export async function runMigrations(): Promise<void> {
  if (!pool) {
    console.log("[DB] Skipping migrations — no DATABASE_URL (in-memory mode)");
    return;
  }

  const client = await pool.connect();
  try {
    console.log("[DB] Running schema migrations...");

    // ── Create tables if they don't exist yet ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        id                    SERIAL PRIMARY KEY,
        running               BOOLEAN   NOT NULL DEFAULT false,
        mode                  TEXT      NOT NULL DEFAULT 'test',
        balance               REAL      NOT NULL DEFAULT 20,
        starting_balance      REAL      NOT NULL DEFAULT 20,
        total_pnl             REAL      NOT NULL DEFAULT 0,
        total_trades          INTEGER   NOT NULL DEFAULT 0,
        winning_trades        INTEGER   NOT NULL DEFAULT 0,
        losing_trades         INTEGER   NOT NULL DEFAULT 0,
        current_position      TEXT,
        current_market_price  REAL,
        last_signal           TEXT,
        kelly_fraction        REAL      NOT NULL DEFAULT 0.25,
        min_edge_threshold    REAL      NOT NULL DEFAULT 0.12,
        sizing_mode           TEXT      NOT NULL DEFAULT 'kelly',
        flat_size_usdc        REAL      NOT NULL DEFAULT 1.0,
        last_updated          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        loss_streak           INTEGER   NOT NULL DEFAULT 0,
        sizing_multiplier     REAL      NOT NULL DEFAULT 1.0,
        daily_start_balance   REAL,
        weekly_start_balance  REAL,
        daily_stop_triggered  BOOLEAN   NOT NULL DEFAULT false,
        weekly_stop_triggered BOOLEAN   NOT NULL DEFAULT false,
        drawdown_paused       BOOLEAN   NOT NULL DEFAULT false,
        sniper_mode           TEXT      NOT NULL DEFAULT 'late'
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id                SERIAL PRIMARY KEY,
        timestamp         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        direction         TEXT        NOT NULL,
        market_price      REAL        NOT NULL,
        estimated_prob    REAL        NOT NULL,
        edge              REAL        NOT NULL,
        kelly_fraction    REAL        NOT NULL,
        position_size     REAL        NOT NULL,
        shares            REAL        NOT NULL,
        price_impact      REAL        NOT NULL,
        exit_price        REAL,
        pnl               REAL,
        status            TEXT        NOT NULL DEFAULT 'open',
        btc_price_at_entry REAL       NOT NULL,
        market_id         TEXT        NOT NULL,
        resolved_at       TIMESTAMPTZ,
        mode              TEXT        NOT NULL DEFAULT 'test'
      )
    `);

    // ── Add any columns missing from older deployments ─────────────────────
    // These are safe no-ops if the column already exists (created above or
    // present from a previous migration run).
    const patches = [
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS loss_streak           INTEGER   NOT NULL DEFAULT 0`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS sizing_multiplier     REAL      NOT NULL DEFAULT 1.0`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS daily_start_balance   REAL`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS weekly_start_balance  REAL`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS daily_stop_triggered  BOOLEAN   NOT NULL DEFAULT false`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS weekly_stop_triggered BOOLEAN   NOT NULL DEFAULT false`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS drawdown_paused       BOOLEAN   NOT NULL DEFAULT false`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS sniper_mode           TEXT      NOT NULL DEFAULT 'late'`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS daily_trade_count     INTEGER   NOT NULL DEFAULT 0`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS smart_exit            BOOLEAN   NOT NULL DEFAULT true`,
    ];

    for (const sql of patches) {
      await client.query(sql);
    }

    // ── Data-driven threshold upgrades ────────────────────────────────────────
    // If the row still has the old 12% default, upgrade it to the new 19%
    // minimum that the trade-performance analysis identified as the edge sweet
    // spot (19–21% edge → 75–90% win rate vs 12–18% → random noise).
    await client.query(
      `UPDATE bot_state SET min_edge_threshold = 0.19 WHERE min_edge_threshold <= 0.12`
    );

    console.log("[DB] Migrations complete ✓");
  } catch (err) {
    // Log the full error so it appears in Render's deployment logs
    console.error("[DB] Migration failed:", err);
    throw err; // Re-throw so the server doesn't silently start with a broken schema
  } finally {
    client.release();
  }
}
