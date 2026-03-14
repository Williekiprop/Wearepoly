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
  minEdgeThreshold: real("min_edge_threshold").notNull().default(0.03),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBotStateSchema = createInsertSchema(botStateTable).omit({ id: true });
export type InsertBotState = z.infer<typeof insertBotStateSchema>;
export type BotState = typeof botStateTable.$inferSelect;
