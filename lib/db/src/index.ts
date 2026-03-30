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
            minEdgeThreshold: data.minEdgeThreshold ?? 0.03,
            sizingMode: data.sizingMode ?? "flat",
            flatSizeUsdc: data.flatSizeUsdc ?? 1.0,
            lastUpdated: data.lastUpdated ?? now,
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
