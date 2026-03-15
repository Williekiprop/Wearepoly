import { Router, type IRouter } from "express";
import { getBotState, startBot, stopBot, resetBot, setSizingMode, dequeueBrowserOrder, completeBrowserOrder } from "../lib/botEngine.js";
import { hasProxy, setProxyUrl, getProxyDisplay, testProxy, polyFetch } from "../lib/proxiedFetch.js";
import { ethers } from "ethers";
import * as crypto from "crypto";

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
 * The dashboard polls GET /bot/pending-order; when an order is ready, the browser
 * POSTs it directly to Polymarket (from the user's VPN machine) and then calls
 * POST /bot/complete-order to record the result.
 */
router.get("/bot/pending-order", (_req, res): void => {
  const pending = dequeueBrowserOrder();
  if (!pending) { res.json({ pending: null }); return; }
  // Return the full request payload + trade context so the browser can submit and report back
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

router.post("/bot/complete-order", async (req, res): Promise<void> => {
  const { orderId, success, errorMessage, context } = req.body as {
    orderId?: string;
    success: boolean;
    errorMessage?: string;
    context: Parameters<typeof completeBrowserOrder>[3];
  };
  await completeBrowserOrder(orderId, success, errorMessage, context);
  res.json({ ok: true });
});

export default router;
