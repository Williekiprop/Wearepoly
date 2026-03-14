import { Router, type IRouter } from "express";
import { getBotState, startBot, stopBot, resetBot } from "../lib/botEngine.js";

const router: IRouter = Router();

router.get("/bot/status", async (_req, res): Promise<void> => {
  const state = await getBotState();
  const winRate = state.totalTrades > 0 ? state.winningTrades / state.totalTrades : 0;
  res.json({
    running: state.running,
    mode: state.mode,
    balance: state.balance,
    startingBalance: state.startingBalance,
    totalPnl: state.totalPnl,
    totalTrades: state.totalTrades,
    winningTrades: state.winningTrades,
    losingTrades: state.losingTrades,
    winRate,
    currentPosition: state.currentPosition ?? null,
    currentMarketPrice: state.currentMarketPrice ?? null,
    lastSignal: state.lastSignal ?? null,
    lastUpdated: state.lastUpdated.toISOString(),
  });
});

router.post("/bot/start", async (req, res): Promise<void> => {
  const { mode, startingBalance, kellyFraction, minEdgeThreshold } = req.body as {
    mode: "test" | "live";
    startingBalance: number;
    kellyFraction?: number;
    minEdgeThreshold?: number;
  };

  if (!mode || startingBalance == null) {
    res.status(400).json({ error: "mode and startingBalance are required" });
    return;
  }

  const state = await startBot({ mode, startingBalance, kellyFraction, minEdgeThreshold });
  const winRate = state.totalTrades > 0 ? state.winningTrades / state.totalTrades : 0;
  res.json({
    running: state.running,
    mode: state.mode,
    balance: state.balance,
    startingBalance: state.startingBalance,
    totalPnl: state.totalPnl,
    totalTrades: state.totalTrades,
    winningTrades: state.winningTrades,
    losingTrades: state.losingTrades,
    winRate,
    currentPosition: state.currentPosition ?? null,
    currentMarketPrice: state.currentMarketPrice ?? null,
    lastSignal: state.lastSignal ?? null,
    lastUpdated: state.lastUpdated.toISOString(),
  });
});

router.post("/bot/stop", async (_req, res): Promise<void> => {
  const state = await stopBot();
  const winRate = state.totalTrades > 0 ? state.winningTrades / state.totalTrades : 0;
  res.json({
    running: state.running,
    mode: state.mode,
    balance: state.balance,
    startingBalance: state.startingBalance,
    totalPnl: state.totalPnl,
    totalTrades: state.totalTrades,
    winningTrades: state.winningTrades,
    losingTrades: state.losingTrades,
    winRate,
    currentPosition: state.currentPosition ?? null,
    currentMarketPrice: state.currentMarketPrice ?? null,
    lastSignal: state.lastSignal ?? null,
    lastUpdated: state.lastUpdated.toISOString(),
  });
});

router.post("/bot/reset", async (_req, res): Promise<void> => {
  const state = await resetBot();
  const winRate = state.totalTrades > 0 ? state.winningTrades / state.totalTrades : 0;
  res.json({
    running: state.running,
    mode: state.mode,
    balance: state.balance,
    startingBalance: state.startingBalance,
    totalPnl: state.totalPnl,
    totalTrades: state.totalTrades,
    winningTrades: state.winningTrades,
    losingTrades: state.losingTrades,
    winRate,
    currentPosition: state.currentPosition ?? null,
    currentMarketPrice: state.currentMarketPrice ?? null,
    lastSignal: state.lastSignal ?? null,
    lastUpdated: state.lastUpdated.toISOString(),
  });
});

export default router;
