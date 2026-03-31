import { Router } from "express";
import { runBacktest } from "../lib/backtest.js";

const router = Router();

/**
 * GET /api/backtest?windows=100
 * Run the historical backtest for the last N 5-minute BTC windows.
 * windows: 20–200 (default 100). More windows = slower response (~1–2s per 10).
 */
router.get("/backtest", async (req, res) => {
  const raw     = Number(req.query.windows ?? 100);
  const windows = Math.min(200, Math.max(20, isNaN(raw) ? 100 : raw));

  console.log(`[BACKTEST] Starting backtest for ${windows} windows...`);
  try {
    const result = await runBacktest(windows);
    console.log(
      `[BACKTEST] Done — ${result.trades.length} trades found in ` +
      `${result.windowsResolved}/${result.windowsScanned} resolved markets ` +
      `(${result.durationMs}ms)`,
    );
    return res.json(result);
  } catch (err) {
    console.error("[BACKTEST] Error:", err);
    return res.status(500).json({ error: "Backtest failed", detail: String(err) });
  }
});

export default router;
