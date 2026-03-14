/**
 * Bot Engine
 * - Reads real BTC prices from Kraken
 * - Reads real contract prices from Polymarket
 * - Computes EV + Kelly sizing against the real market price
 * - TEST mode: simulates trade outcomes probabilistically — no real money
 * - LIVE mode: places real orders via Polymarket CLOB API with EIP-712 signing
 */

import { db, botStateTable, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { calcKelly, simulatePriceImpact } from "./lmsr.js";
import { getBtcPriceData, estimateTrueProb } from "./btcPrice.js";
import { getBestBtcMarketPrice, getConnectionStatus } from "./polymarketClient.js";
import { placeOrder, getClobTokenId, getWalletBalance } from "./polymarketOrder.js";

const B_PARAM = 100;

// Minimum $0.50 USDC per live order (Polymarket minimum)
const MIN_LIVE_ORDER_USDC = 0.50;

let pollingInterval: ReturnType<typeof setInterval> | null = null;

async function ensureBotState() {
  const [existing] = await db.select().from(botStateTable).limit(1);
  if (!existing) {
    await db.insert(botStateTable).values({
      running: false,
      mode: "test",
      balance: 20,
      startingBalance: 20,
      totalPnl: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      currentPosition: undefined,
      currentMarketPrice: undefined,
      lastSignal: undefined,
      kellyFraction: 0.25,
      minEdgeThreshold: 0.03,
    });
    const [state] = await db.select().from(botStateTable).limit(1);
    return state;
  }
  return existing;
}

export async function getBotState() {
  return ensureBotState();
}

export async function startBot(opts: {
  mode: "test" | "live";
  startingBalance: number;
  kellyFraction?: number;
  minEdgeThreshold?: number;
}) {
  stopPolling();
  const state = await ensureBotState();

  await db.delete(tradesTable);

  // For live mode, fetch real balance from Polymarket wallet
  let initialBalance = opts.startingBalance;
  if (opts.mode === "live") {
    const walletBalance = await getWalletBalance();
    if (walletBalance !== null && walletBalance > 0) {
      initialBalance = walletBalance;
      console.log(`[LIVE] Wallet balance: $${walletBalance.toFixed(2)} USDC`);
    } else {
      console.warn("[LIVE] Could not fetch wallet balance, using provided starting balance");
    }
  }

  await db
    .update(botStateTable)
    .set({
      running: true,
      mode: opts.mode,
      balance: initialBalance,
      startingBalance: initialBalance,
      totalPnl: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      currentPosition: undefined,
      currentMarketPrice: undefined,
      lastSignal: opts.mode === "live" ? "LIVE MODE — Connecting..." : "Connecting to Polymarket...",
      kellyFraction: opts.kellyFraction ?? 0.25,
      minEdgeThreshold: opts.minEdgeThreshold ?? 0.03,
      lastUpdated: new Date(),
    })
    .where(eq(botStateTable.id, state.id));

  startPolling(state.id);
  return getBotState();
}

export async function stopBot() {
  stopPolling();
  const state = await ensureBotState();

  await db
    .update(botStateTable)
    .set({ running: false, lastSignal: "Bot stopped", lastUpdated: new Date() })
    .where(eq(botStateTable.id, state.id));

  return getBotState();
}

export async function resetBot() {
  stopPolling();
  const state = await ensureBotState();

  await db
    .update(botStateTable)
    .set({
      running: false,
      balance: 20,
      startingBalance: 20,
      totalPnl: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      currentPosition: undefined,
      currentMarketPrice: undefined,
      lastSignal: "Reset complete",
      lastUpdated: new Date(),
    })
    .where(eq(botStateTable.id, state.id));

  await db.delete(tradesTable);
  return getBotState();
}

function startPolling(botId: number) {
  stopPolling();
  pollingInterval = setInterval(() => runBotCycle(botId), 30_000);
  runBotCycle(botId);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

async function runBotCycle(botId: number) {
  try {
    const [state] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (!state || !state.running) return;

    // 1. Real BTC price from Kraken
    const btcData = await getBtcPriceData();

    // 2. Real Polymarket contract price (YES token)
    const polyData = await getBestBtcMarketPrice();
    const marketYesPrice =
      polyData.connected && polyData.yesPrice > 0.01 && polyData.yesPrice < 0.99
        ? polyData.yesPrice
        : 0.5;

    const marketId = polyData.market?.conditionId ?? "btc-sim-market";

    // 3. Momentum-based true probability estimate
    const trueProb = estimateTrueProb(btcData);

    // 4. Edge = our estimate vs market price
    const edge = trueProb - marketYesPrice;
    const evPerShare = trueProb * (1 - marketYesPrice) - (1 - trueProb) * marketYesPrice;

    const isBuyYes = edge > 0;
    const direction: "YES" | "NO" = isBuyYes ? "YES" : "NO";
    const entryPrice = isBuyYes ? marketYesPrice : 1 - marketYesPrice;
    const winProb = isBuyYes ? trueProb : 1 - trueProb;

    let signal: "BUY_YES" | "BUY_NO" | "NO_TRADE" = "NO_TRADE";
    let positionSize = 0;
    let shares = 0;
    let priceImpact = 0;

    if (Math.abs(edge) >= state.minEdgeThreshold && state.balance >= 0.5) {
      signal = isBuyYes ? "BUY_YES" : "BUY_NO";

      const kellyFull = calcKelly(winProb, entryPrice);
      const kellyScaled = kellyFull * state.kellyFraction;
      positionSize = Math.min(state.balance * kellyScaled, state.balance);
      shares = entryPrice > 0 ? positionSize / entryPrice : 0;

      const outcome = isBuyYes ? 0 : 1;
      const { impact } = simulatePriceImpact([0, 0], B_PARAM, outcome, shares);
      priceImpact = impact;

      if (priceImpact > Math.abs(edge) * 0.5) {
        positionSize *= 0.5;
        shares *= 0.5;
      }
    }

    // Update bot status
    await db
      .update(botStateTable)
      .set({
        currentMarketPrice: marketYesPrice,
        lastSignal: signal,
        lastUpdated: new Date(),
      })
      .where(eq(botStateTable.id, botId));

    if (signal === "NO_TRADE" || positionSize < 0.01 || shares <= 0) return;

    if (state.mode === "live") {
      await executeLiveTrade(botId, state, {
        direction,
        marketPrice: marketYesPrice,
        edge,
        evPerShare,
        kellyScaledPct: positionSize / state.balance,
        positionSize,
        shares,
        priceImpact,
      }, btcData.currentPrice, marketId, polyData.market?.conditionId ?? null);
    } else {
      await simulateTrade(botId, state, {
        direction,
        marketPrice: marketYesPrice,
        edge,
        evPerShare,
        kellyScaledPct: positionSize / state.balance,
        positionSize,
        shares,
        priceImpact,
      }, btcData.currentPrice, marketId);
    }
  } catch (err) {
    console.error("Bot cycle error:", err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// LIVE ORDER EXECUTION
// ──────────────────────────────────────────────────────────────────────────────

async function executeLiveTrade(
  botId: number,
  state: {
    id: number;
    balance: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnl: number;
  },
  trade: {
    direction: "YES" | "NO";
    marketPrice: number;
    edge: number;
    evPerShare: number;
    kellyScaledPct: number;
    positionSize: number;
    shares: number;
    priceImpact: number;
  },
  btcPrice: number,
  marketId: string,
  conditionId: string | null,
) {
  const { direction, marketPrice, edge, kellyScaledPct, positionSize, shares, priceImpact } = trade;

  // Enforce minimum order size
  const orderSize = Math.max(positionSize, MIN_LIVE_ORDER_USDC);
  if (orderSize > state.balance) {
    console.log(`[LIVE] Skipping — order size $${orderSize.toFixed(2)} > balance $${state.balance.toFixed(2)}`);
    return;
  }

  // Get the CLOB token ID for this direction
  let tokenId: string | null = null;
  if (conditionId) {
    tokenId = await getClobTokenId(conditionId, direction);
  }

  if (!tokenId) {
    console.error(`[LIVE] Could not get CLOB token ID for ${direction} on ${conditionId}`);
    // Fall back to simulated trade so we don't lose the signal
    await simulateTrade(botId, state, trade, btcPrice, marketId);
    return;
  }

  const limitPrice = direction === "YES" ? marketPrice : 1 - marketPrice;

  console.log(`[LIVE] Placing ${direction} order: $${orderSize.toFixed(2)} USDC @ ${(limitPrice * 100).toFixed(1)}¢ on ${marketId}`);

  const result = await placeOrder({
    tokenId,
    side: "BUY",
    price: limitPrice,
    sizeUsdc: orderSize,
  });

  const trueYesProb = Math.min(0.95, Math.max(0.05, marketPrice + edge));
  const trueProb = trueYesProb;

  if (result.success) {
    // Record as "open" — will close when market resolves
    await db.insert(tradesTable).values({
      direction,
      marketPrice,
      estimatedProb: trueProb,
      edge,
      kellyFraction: kellyScaledPct,
      positionSize: orderSize,
      shares,
      priceImpact,
      exitPrice: null,
      pnl: null,
      status: "open",
      btcPriceAtEntry: btcPrice,
      marketId: result.orderId ? `${marketId}::${result.orderId}` : marketId,
      resolvedAt: null,
      mode: "live",
    });

    // Deduct from balance immediately (USDC spent)
    await db
      .update(botStateTable)
      .set({
        balance: state.balance - orderSize,
        totalTrades: state.totalTrades + 1,
        lastSignal: `LIVE ${direction} — $${orderSize.toFixed(2)} placed`,
        lastUpdated: new Date(),
      })
      .where(eq(botStateTable.id, botId));

    console.log(`[LIVE] Order placed OK: ${result.orderId}`);
  } else {
    const errorMsg = result.errorMessage ?? "";
    console.error(`[LIVE] Order failed: ${errorMsg}`);

    const isGeoblock =
      errorMsg.includes("restricted") ||
      errorMsg.includes("geoblock") ||
      errorMsg.includes("region");

    if (isGeoblock) {
      // Stop immediately — no point retrying a geo-blocked server
      console.error("[LIVE] Geoblock detected — stopping bot. Run locally or on an EU server.");
      stopPolling();
      await db
        .update(botStateTable)
        .set({
          running: false,
          lastSignal: "BLOCKED: Polymarket restricts orders from Replit servers. Run the bot locally or on a non-US VPS to go live.",
          lastUpdated: new Date(),
        })
        .where(eq(botStateTable.id, botId));
    } else {
      await db
        .update(botStateTable)
        .set({
          lastSignal: `ORDER FAILED: ${errorMsg.substring(0, 60)}`,
          lastUpdated: new Date(),
        })
        .where(eq(botStateTable.id, botId));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SIMULATED TRADE (test mode)
// ──────────────────────────────────────────────────────────────────────────────

async function simulateTrade(
  botId: number,
  state: {
    id: number;
    balance: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnl: number;
  },
  trade: {
    direction: "YES" | "NO";
    marketPrice: number;
    edge: number;
    evPerShare: number;
    kellyScaledPct: number;
    positionSize: number;
    shares: number;
    priceImpact: number;
  },
  btcPrice: number,
  marketId: string,
) {
  const { direction, marketPrice, edge, kellyScaledPct, positionSize, shares, priceImpact } = trade;

  const trueYesProb = Math.min(0.95, Math.max(0.05, marketPrice + edge));
  const winProb = direction === "YES" ? trueYesProb : 1 - trueYesProb;
  const trueProb = trueYesProb;

  const won = Math.random() < winProb;
  const exitPrice = won ? 1.0 : 0.0;
  const entryPrice = direction === "YES" ? marketPrice : 1 - marketPrice;
  const pnl = shares * (exitPrice - entryPrice);

  await db.insert(tradesTable).values({
    direction,
    marketPrice,
    estimatedProb: trueProb,
    edge,
    kellyFraction: kellyScaledPct,
    positionSize,
    shares,
    priceImpact,
    exitPrice,
    pnl,
    status: "closed",
    btcPriceAtEntry: btcPrice,
    marketId,
    mode: "test",
    resolvedAt: new Date(),
  });

  await db
    .update(botStateTable)
    .set({
      balance: state.balance + pnl,
      totalTrades: state.totalTrades + 1,
      winningTrades: won ? state.winningTrades + 1 : state.winningTrades,
      losingTrades: won ? state.losingTrades : state.losingTrades + 1,
      totalPnl: state.totalPnl + pnl,
      lastUpdated: new Date(),
    })
    .where(eq(botStateTable.id, botId));
}

// ──────────────────────────────────────────────────────────────────────────────
// MARKET ANALYSIS (for dashboard)
// ──────────────────────────────────────────────────────────────────────────────

export async function getMarketAnalysis() {
  const state = await ensureBotState();

  const [btcData, polyData] = await Promise.all([
    getBtcPriceData(),
    getBestBtcMarketPrice(),
  ]);

  const trueProb = estimateTrueProb(btcData);
  const marketYesPrice =
    polyData.connected && polyData.yesPrice > 0.01 && polyData.yesPrice < 0.99
      ? polyData.yesPrice
      : 0.5;

  const edge = trueProb - marketYesPrice;
  const evPerShare = trueProb * (1 - marketYesPrice) - (1 - trueProb) * marketYesPrice;

  const isBuyYes = edge > 0;
  const entryPrice = isBuyYes ? marketYesPrice : 1 - marketYesPrice;
  const winProb = isBuyYes ? trueProb : 1 - trueProb;

  let signal: "BUY_YES" | "BUY_NO" | "NO_TRADE" = "NO_TRADE";
  let positionSize = 0;
  let priceImpact = 0;

  if (Math.abs(edge) >= state.minEdgeThreshold) {
    signal = isBuyYes ? "BUY_YES" : "BUY_NO";
    const kellyFull = calcKelly(winProb, entryPrice);
    const kellyScaled = kellyFull * state.kellyFraction;
    positionSize = Math.min(state.balance * kellyScaled, state.balance);
    const shares = entryPrice > 0 ? positionSize / entryPrice : 0;
    const outcome = isBuyYes ? 0 : 1;
    const { impact } = simulatePriceImpact([0, 0], B_PARAM, outcome, shares);
    priceImpact = impact;
  }

  return {
    marketId: polyData.market?.conditionId ?? "btc-sim-market",
    marketTitle: polyData.market?.question ?? "Bitcoin Price Market (simulated)",
    currentPrice: marketYesPrice,
    liquidityParam: B_PARAM,
    qYes: 0,
    qNo: 0,
    btcCurrentPrice: btcData.currentPrice,
    btcPriceChange5m: btcData.change5m,
    btcPriceChange1h: btcData.change1h,
    estimatedTrueProb: trueProb,
    edge,
    signal,
    evPerShare,
    recommendedDirection: (edge > 0 ? "YES" : edge < 0 ? "NO" : null) as "YES" | "NO" | null,
    kellySize: positionSize,
    priceImpact,
    analysisTime: new Date().toISOString(),
  };
}

export { getConnectionStatus };
