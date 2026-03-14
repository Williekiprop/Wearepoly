import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { desc, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/trades", async (req, res): Promise<void> => {
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 200);
  const offset = parseInt((req.query.offset as string) || "0", 10);

  const [trades, countResult] = await Promise.all([
    db.select().from(tradesTable).orderBy(desc(tradesTable.timestamp)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(tradesTable),
  ]);

  res.json({
    trades: trades.map((t) => ({
      id: t.id,
      timestamp: t.timestamp.toISOString(),
      direction: t.direction,
      marketPrice: t.marketPrice,
      estimatedProb: t.estimatedProb,
      edge: t.edge,
      kellyFraction: t.kellyFraction,
      positionSize: t.positionSize,
      shares: t.shares,
      priceImpact: t.priceImpact,
      exitPrice: t.exitPrice ?? null,
      pnl: t.pnl ?? null,
      status: t.status,
      btcPriceAtEntry: t.btcPriceAtEntry,
      marketId: t.marketId,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      mode: t.mode,
    })),
    total: Number(countResult[0]?.count ?? 0),
  });
});

export default router;
