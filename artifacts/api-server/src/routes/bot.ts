import { Router, type IRouter } from "express";
import { getBotState, startBot, stopBot, resetBot, setSizingMode, setMinEdgeThreshold, dequeueBrowserOrder, completeBrowserOrder, syncWalletBalance, resetDrawdownStops } from "../lib/botEngine.js";
import { hasProxy, setProxyUrl, getProxyDisplay, getGeoblockCooldownMs, resetGeoblockCooldown, testProxy, polyFetch } from "../lib/proxiedFetch.js";
import { getBtcWsStatus } from "../lib/btcPrice.js";
import { ethers } from "ethers";
import * as crypto from "crypto";

const router: IRouter = Router();

function formatState(state: Awaited<ReturnType<typeof getBotState>>) {
  const winRate = state.totalTrades > 0 ? state.winningTrades / state.totalTrades : 0;
  const geoblockCooldownMs = getGeoblockCooldownMs();

  // Compute daily/weekly drawdown percentages for the dashboard
  const dailyLossPct = state.dailyStartBalance && state.dailyStartBalance > 0
    ? (state.dailyStartBalance - state.balance) / state.dailyStartBalance
    : 0;
  const weeklyLossPct = state.weeklyStartBalance && state.weeklyStartBalance > 0
    ? (state.weeklyStartBalance - state.balance) / state.weeklyStartBalance
    : 0;

  return {
    running: state.running,
    mode: state.mode,
    balance: state.balance,
    startingBalance: state.startingBalance,
    totalTrades: state.totalTrades,
    winningTrades: state.winningTrades,
    losingTrades: state.losingTrades,
    winRate,
    currentPosition: state.currentPosition ?? null,
    currentMarketPrice: state.currentMarketPrice ?? null,
    lastSignal: state.lastSignal ?? null,
    sizingMode: state.sizingMode,
    flatSizeUsdc: state.flatSizeUsdc,
    minEdgeThreshold: state.minEdgeThreshold,
    proxyEnabled: hasProxy(),
    proxyDisplay: getProxyDisplay(),
    geoblockCooldownMs,
    geoblockCooldownSec: Math.ceil(geoblockCooldownMs / 1000),
    lastUpdated: state.lastUpdated.toISOString(),
    // Drawdown protection fields
    lossStreak: state.lossStreak ?? 0,
    sizingMultiplier: state.sizingMultiplier ?? 1.0,
    drawdownPaused: state.drawdownPaused ?? false,
    dailyStopTriggered: state.dailyStopTriggered ?? false,
    weeklyStopTriggered: state.weeklyStopTriggered ?? false,
    dailyLossPct,
    weeklyLossPct,
    dailyStartBalance: state.dailyStartBalance ?? state.balance,
    weeklyStartBalance: state.weeklyStartBalance ?? state.balance,
    // Data source health
    btcWs: getBtcWsStatus(),
    // P&L derived from balance - startingBalance (always mathematically consistent,
    // avoids drift in the accumulated totalPnl column from concurrent writes).
    totalPnl: state.balance - (state.startingBalance ?? state.balance),
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

router.get("/bot/proxy/test", async (_req, res): Promise<void> => {
  const result = await testProxy();
  res.json(result);
});

router.post("/bot/stop", async (_req, res): Promise<void> => {
  const state = await stopBot();
  res.json(formatState(state));
});

router.post("/bot/reset", async (_req, res): Promise<void> => {
  const state = await resetBot();
  res.json(formatState(state));
});

router.post("/bot/set-threshold", async (req, res): Promise<void> => {
  const { minEdgeThreshold } = req.body as { minEdgeThreshold: number };
  if (typeof minEdgeThreshold !== "number" || minEdgeThreshold < 0 || minEdgeThreshold > 1) {
    res.status(400).json({ error: "minEdgeThreshold must be a number between 0 and 1" });
    return;
  }
  const state = await setMinEdgeThreshold(minEdgeThreshold);
  res.json(formatState(state));
});

router.post("/bot/proxy/retry", async (_req, res): Promise<void> => {
  if (!hasProxy()) {
    res.status(400).json({ error: "No proxy configured" });
    return;
  }
  resetGeoblockCooldown();
  const state = await getBotState();
  res.json({ ...formatState(state), message: "Geoblock cooldown reset — proxy will retry on next bot cycle" });
});

router.post("/bot/sync-balance", async (_req, res): Promise<void> => {
  const newBalance = await syncWalletBalance();
  const state = await getBotState();
  res.json({ ...formatState(state), syncedBalance: newBalance });
});

router.post("/bot/reset-stops", async (_req, res): Promise<void> => {
  const state = await getBotState();
  await resetDrawdownStops(state.id);
  const updated = await getBotState();
  res.json(formatState(updated));
});

router.get("/bot/api-test", async (_req, res): Promise<void> => {
  const key = process.env.POLYMARKET_API_KEY ?? "";
  const secret = process.env.POLYMARKET_API_SECRET ?? "";
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE ?? "";
  const pk = process.env.POLYMARKET_WALLET_KEY ?? "";

  const walletAddress = pk
    ? (() => { try { const k = pk.startsWith("0x") ? pk : `0x${pk}`; return new ethers.Wallet(k).address; } catch { return "INVALID_KEY"; } })()
    : "NOT_SET";

  const timestamp = Math.floor(Date.now() / 1000);
  const path = `/balance-allowance?asset_type=USDC&signature_type=0`;
  const message = `${timestamp}GET${path}`;
  let secretBuffer: Buffer;
  try { secretBuffer = Buffer.from(secret, "base64"); } catch { secretBuffer = Buffer.from(secret); }
  const signature = crypto.createHmac("sha256", secretBuffer).update(message).digest("base64");

  let polyResponse = "";
  let polyStatus = 0;
  try {
    const r = await polyFetch(`https://clob.polymarket.com${path}`, {
      headers: {
        "POLY-API-KEY": key,
        "POLY-PASSPHRASE": passphrase,
        "POLY-TIMESTAMP": String(timestamp),
        "POLY-SIGNATURE": signature,
        "POLY-ADDRESS": walletAddress,
      },
      signal: AbortSignal.timeout(8000),
    });
    polyStatus = r.status;
    polyResponse = await r.text();
  } catch (e) {
    polyResponse = String(e);
  }

  res.json({
    walletAddress,
    keySet: !!key,
    secretSet: !!secret,
    passphraseSet: !!passphrase,
    keyPreview: key ? `${key.slice(0, 8)}...` : "NOT_SET",
    secretLength: secret.length,
    polyStatus,
    polyResponse,
  });
});

/**
 * Browser-relay endpoints.
 *
 * GET  /bot/pending-order   – browser polls for the next queued order
 * POST /bot/relay-submit    – browser posts signed order body here; server forwards to Polymarket
 *                             (bypasses browser CSP/Cloudflare block; uses proxy if set)
 * POST /bot/complete-order  – browser reports final success/failure result
 */
router.get("/bot/pending-order", (_req, res): void => {
  const pending = dequeueBrowserOrder();
  if (!pending) { res.json({ pending: null }); return; }
  res.json({
    pending: {
      id: pending.prepared.id,
      url: pending.prepared.url,
      method: pending.prepared.method,
      headers: pending.prepared.headers,
      body: pending.prepared.body,
      meta: pending.prepared.meta,
      context: { ...pending.tradeContext, botId: pending.botId },
    },
  });
});

/**
 * Server-forward relay: browser sends the signed order to OUR server,
 * server forwards to Polymarket via polyFetch (which uses the proxy if set).
 * This bypasses Cloudflare browser-fingerprint blocks and Replit CSP restrictions.
 */
router.post("/bot/relay-submit", async (req, res): Promise<void> => {
  const { url, method, headers: reqHeaders, body } = req.body as {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
  if (!url || !body) { res.status(400).json({ error: "url and body required" }); return; }
  try {
    const upstream = await polyFetch(url, {
      method: method ?? "POST",
      headers: { "Content-Type": "application/json", ...reqHeaders },
      body,
      signal: AbortSignal.timeout(12000),
    });
    const text = await upstream.text();
    res.status(upstream.status).set("Content-Type", "application/json").send(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg });
  }
});

router.post("/bot/complete-order", async (req, res): Promise<void> => {
  const { orderId, success, errorMessage, context, actualShares, clobStatus } = req.body as {
    orderId?: string;
    success: boolean;
    errorMessage?: string;
    context: Parameters<typeof completeBrowserOrder>[3];
    actualShares?: number; // actual tokens received/sent as reported by CLOB
    clobStatus?: string;   // "matched" = settled on-chain; "live" = open in order book
  };
  await completeBrowserOrder(orderId, success, errorMessage, context, actualShares, clobStatus);
  res.json({ ok: true });
});

export default router;
