import { pgTable, serial, text, real, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  direction: text("direction", { enum: ["YES", "NO"] }).notNull(),
  marketPrice: real("market_price").notNull(),
  estimatedProb: real("estimated_prob").notNull(),
  edge: real("edge").notNull(),
  kellyFraction: real("kelly_fraction").notNull(),
  positionSize: real("position_size").notNull(),
  shares: real("shares").notNull(),
  priceImpact: real("price_impact").notNull(),
  exitPrice: real("exit_price"),
  pnl: real("pnl"),
  status: text("status", { enum: ["open", "closed", "cancelled"] }).notNull().default("open"),
  btcPriceAtEntry: real("btc_price_at_entry").notNull(),
  marketId: text("market_id").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  mode: text("mode", { enum: ["test", "live"] }).notNull().default("test"),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
