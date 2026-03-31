import { pgTable, serial, text, real, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botStateTable = pgTable("bot_state", {
  id: serial("id").primaryKey(),
  running: boolean("running").notNull().default(false),
  mode: text("mode", { enum: ["test", "live"] }).notNull().default("test"),
  balance: real("balance").notNull().default(20),
  startingBalance: real("starting_balance").notNull().default(20),
  totalPnl: real("total_pnl").notNull().default(0),
  totalTrades: integer("total_trades").notNull().default(0),
  winningTrades: integer("winning_trades").notNull().default(0),
  losingTrades: integer("losing_trades").notNull().default(0),
  currentPosition: text("current_position", { enum: ["YES", "NO"] }),
  currentMarketPrice: real("current_market_price"),
  lastSignal: text("last_signal"),
  kellyFraction: real("kelly_fraction").notNull().default(0.25),
  minEdgeThreshold: real("min_edge_threshold").notNull().default(0.19),
  sizingMode: text("sizing_mode", { enum: ["flat", "kelly"] }).notNull().default("kelly"),
  flatSizeUsdc: real("flat_size_usdc").notNull().default(1.0),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
  // ── Drawdown & risk controls ──────────────────────────────────────────────
  lossStreak: integer("loss_streak").notNull().default(0),
  sizingMultiplier: real("sizing_multiplier").notNull().default(1.0),
  dailyStartBalance: real("daily_start_balance"),
  weeklyStartBalance: real("weekly_start_balance"),
  dailyStopTriggered: boolean("daily_stop_triggered").notNull().default(false),
  weeklyStopTriggered: boolean("weekly_stop_triggered").notNull().default(false),
  drawdownPaused: boolean("drawdown_paused").notNull().default(false),
  // ── Sniper mode ──────────────────────────────────────────────────────────
  // "late"  = enter only in final 5–90s (original behaviour, widened from 40s)
  // "edge"  = enter when 91–240s remain, exit early on TP or signal flip
  // "both"  = edge snipes mid-window PLUS late snipe in final 90s
  sniperMode: text("sniper_mode", { enum: ["late", "edge", "both"] }).notNull().default("late"),
  // ── Daily trade counter ───────────────────────────────────────────────────
  // Resets to 0 at UTC midnight. Trading pauses when this hits MAX_DAILY_TRADES.
  dailyTradeCount: integer("daily_trade_count").notNull().default(0),
});

export const insertBotStateSchema = createInsertSchema(botStateTable).omit({ id: true });
export type InsertBotState = z.infer<typeof insertBotStateSchema>;
export type BotState = typeof botStateTable.$inferSelect;
