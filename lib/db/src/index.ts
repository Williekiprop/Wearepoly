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
            minEdgeThreshold: data.minEdgeThreshold ?? 0.12,
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

// ── Auto-migration (runs on every startup, idempotent) ────────────────────────
// Adds any columns that exist in the schema but are missing from the live DB.
// Uses IF NOT EXISTS so it is always safe to re-run.
export async function runMigrations(): Promise<void> {
  if (!pool) {
    console.log("[DB] Skipping migrations — no DATABASE_URL (in-memory mode)");
    return;
  }

  const client = await pool.connect();
  try {
    console.log("[DB] Running schema migrations...");

    // bot_state columns added after initial deployment
    const botStateMigrations = [
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS loss_streak         INTEGER     NOT NULL DEFAULT 0`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS sizing_multiplier   REAL        NOT NULL DEFAULT 1.0`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS daily_start_balance REAL`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS weekly_start_balance REAL`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS daily_stop_triggered  BOOLEAN  NOT NULL DEFAULT false`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS weekly_stop_triggered BOOLEAN  NOT NULL DEFAULT false`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS drawdown_paused       BOOLEAN  NOT NULL DEFAULT false`,
      `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS sniper_mode           TEXT     NOT NULL DEFAULT 'late'`,
    ];

    for (const sql of botStateMigrations) {
      await client.query(sql);
    }

    console.log("[DB] Migrations complete ✓");
  } catch (err) {
    console.error("[DB] Migration error:", err);
    // Don't throw — a migration failure should not crash the server
  } finally {
    client.release();
  }
}
