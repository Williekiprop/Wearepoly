import { Router, type IRouter } from "express";
import { getBotState, startBot, stopBot, resetBot, setSizingMode } from "../lib/botEngine.js";
import { hasProxy, setProxyUrl, getProxyDisplay } from "../lib/proxiedFetch.js";

const router: IRouter = Router();

function formatState(state: Awaited<ReturnType<typeof getBotState>>) {
  const winRate = state.totalTrades > 0 ? state.winningTrades / state.totalTrades : 0;
  return {
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
    sizingMode: state.sizingMode,
    flatSizeUsdc: state.flatSizeUsdc,
    proxyEnabled: hasProxy(),
    proxyDisplay: getProxyDisplay(),
    lastUpdated: state.lastUpdated.toISOString(),
  };
}

router.get("/bot/status", async (_req, res): Promise<void> => {
  const state = await getBotState();
  res.json(formatState(state));
});

router.post("/bot/start", async (req, res): Promise<void> => {
  const { mode, startingBalance, kellyFraction, minEdgeThreshold, sizingMode, flatSizeUsdc } = req.body as {
    mode: "test" | "live";
    startingBalance: number;
    kellyFraction?: number;
    minEdgeThreshold?: number;
    sizingMode?: "flat" | "kelly";
    flatSizeUsdc?: number;
  };

  if (!mode || startingBalance == null) {
    res.status(400).json({ error: "mode and startingBalance are required" });
    return;
  }

  const state = await startBot({ mode, startingBalance, kellyFraction, minEdgeThreshold, sizingMode, flatSizeUsdc });
  res.json(formatState(state));
});

router.patch("/bot/sizing", async (req, res): Promise<void> => {
  const { sizingMode, flatSizeUsdc } = req.body as {
    sizingMode: "flat" | "kelly";
    flatSizeUsdc?: number;
  };
  if (!sizingMode || !["flat", "kelly"].includes(sizingMode)) {
    res.status(400).json({ error: "sizingMode must be 'flat' or 'kelly'" });
    return;
  }
  const state = await setSizingMode(sizingMode, flatSizeUsdc);
  res.json(formatState(state));
});

router.patch("/bot/proxy", (req, res): void => {
  const { proxyUrl } = req.body as { proxyUrl?: string };
  setProxyUrl(proxyUrl ?? null);
  res.json({ ok: true, proxyEnabled: hasProxy(), proxyDisplay: getProxyDisplay() });
});

router.post("/bot/stop", async (_req, res): Promise<void> => {
  const state = await stopBot();
  res.json(formatState(state));
});

router.post("/bot/reset", async (_req, res): Promise<void> => {
  const state = await resetBot();
  res.json(formatState(state));
});

export default router;
