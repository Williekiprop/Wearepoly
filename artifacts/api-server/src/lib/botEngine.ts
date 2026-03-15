/**
 * Bot Engine
 * - Reads real BTC prices from Kraken
 * - Reads real Polymarket contract prices
 * - Computes EV + Kelly sizing
 *
 * TEST mode: paper-trades against the live Polymarket feed.
 *   - Opens positions at the real Polymarket market price (entry cost)
 *   - Holds for 2 cycles (60s), then closes marked to MODEL probability
 *   - Exit fair value = estimateTrueProb(currentBtcData) — driven by actual BTC movement
 *   - This is "mark-to-model": P&L reflects BTC momentum, not illiquid Polymarket quotes
 *
 * LIVE mode: places real USDC orders on Polymarket CLOB via EIP-712 signing
 */

import { db, botStateTable, tradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { calcKelly, simulatePriceImpact } from "./lmsr.js";
import { getBtcPriceData, estimateTrueProb } from "./btcPrice.js";
import { getBestBtcMarketPrice, getConnectionStatus } from "./polymarketClient.js";
import { placeOrder, prepareOrderForBrowser, getClobTokenId, getWalletBalance, type PreparedBrowserOrder } from "./polymarketOrder.js";
import { hasProxy, setProxyUrl } from "./proxiedFetch.js";

const B_PARAM = 100;
const MIN_LIVE_ORDER_USDC = 0.50;

// ──────────────────────────────────────────────────────────────────────────────
// BROWSER-RELAY ORDER QUEUE
// Orders queued here when no proxy is active — browser picks them up and POSTs
// directly to Polymarket from the user's VPN-connected machine.
// ──────────────────────────────────────────────────────────────────────────────
interface PendingBrowserOrder {
  prepared: PreparedBrowserOrder;
  botId: number;
  tradeContext: {
    direction: "YES" | "NO";
    marketPrice: number;
    estimatedProb: number;
    edge: number;
    kellyScaledPct: number;
    positionSize: number;
    shares: number;
    priceImpact: number;
    btcPrice: number;
    marketId: string;
  };
  queuedAt: number;
}

const browserOrderQueue: PendingBrowserOrder[] = [];

/** Called by the API route: browser polls for the next pending order. */
export function dequeueBrowserOrder(): PendingBrowserOrder | null {
  // Expire orders older than 50s (HMAC timestamp window)
  const now = Date.now();
  while (browserOrderQueue.length > 0 && now - browserOrderQueue[0].queuedAt > 50_000) {
    browserOrderQueue.shift();
  }
  return browserOrderQueue.shift() ?? null;
}

/** Called by the API route: browser reports success/failure after submitting to Polymarket. */
export async function completeBrowserOrder(
  orderId: string | undefined,
  success: boolean,
  errorMessage: string | undefined,
  ctx: PendingBrowserOrder["tradeContext"] & { botId: number }
): Promise<void> {
  const { botId, direction, marketPrice, estimatedProb, edge, kellyScaledPct,
    positionSize, shares, priceImpact, btcPrice, marketId } = ctx;

  if (success && orderId) {
    await db.insert(tradesTable).values({
      direction, marketPrice, estimatedProb, edge,
      kellyFraction: kellyScaledPct, positionSize, shares, priceImpact,
      exitPrice: null, pnl: null, status: "open",
      btcPriceAtEntry: btcPrice,
      marketId: `${marketId}::${orderId}`,
      resolvedAt: null, mode: "live",
    });
    const [state] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (state) {
      await db.update(botStateTable).set({
        balance: state.balance - positionSize,
        totalTrades: state.totalTrades + 1,
        lastSignal: `LIVE ${direction} — $${positionSize.toFixed(2)} placed`,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
    }
    console.log(`[LIVE/BROWSER] Order placed OK: ${orderId}`);
  } else {
    console.error(`[LIVE/BROWSER] Order failed: ${errorMessage}`);
    const [state] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (state) {
      await db.update(botStateTable).set({
        lastSignal: `ORDER FAILED: ${(errorMessage ?? "").substring(0, 60)}`,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
    }
  }
}

// How many 30s cycles to hold a test position before closing at market price
const TEST_HOLD_CYCLES = 2; // 60 seconds

let pollingInterval: ReturnType<typeof setInterval> | null = null;

// ──────────────────────────────────────────────────────────────────────────────
// STATE MANAGEMENT
// ──────────────────────────────────────────────────────────────────────────────

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
      sizingMode: "flat",
      flatSizeUsdc: 1.0,
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
  sizingMode?: "flat" | "kelly";
  flatSizeUsdc?: number;
}) {
  stopPolling();
  const state = await ensureBotState();
  await db.delete(tradesTable);

  let initialBalance = opts.startingBalance;
  if (opts.mode === "live") {
    const walletBalance = await getWalletBalance();
    if (walletBalance !== null && walletBalance > 0) {
      initialBalance = walletBalance;
      console.log(`[LIVE] Wallet balance: $${walletBalance.toFixed(2)} USDC`);
    } else {
      console.warn("[LIVE] Could not fetch wallet balance, using provided balance");
    }
  }

  const sizingMode = opts.sizingMode ?? "kelly";
  const flatSizeUsdc = opts.flatSizeUsdc ?? 1.0;

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
      lastSignal: opts.mode === "live" ? "LIVE MODE — Connecting..." : "Paper trading on live feed...",
      kellyFraction: opts.kellyFraction ?? 0.25,
      minEdgeThreshold: opts.minEdgeThreshold ?? 0.03,
      sizingMode,
      flatSizeUsdc,
      lastUpdated: new Date(),
    })
    .where(eq(botStateTable.id, state.id));

  startPolling(state.id);
  return getBotState();
}

export async function setSizingMode(mode: "flat" | "kelly", flatSizeUsdc?: number) {
  const state = await ensureBotState();
  await db
    .update(botStateTable)
    .set({
      sizingMode: mode,
      ...(flatSizeUsdc != null ? { flatSizeUsdc } : {}),
      lastUpdated: new Date(),
    })
    .where(eq(botStateTable.id, state.id));
  return getBotState();
}

export async function stopBot() {
  stopPolling();
  const state = await ensureBotState();
  // Close any open test positions at last known price
  await forceCloseOpenTestPositions(state.id);
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

// ──────────────────────────────────────────────────────────────────────────────
// MAIN CYCLE
// ──────────────────────────────────────────────────────────────────────────────

async function runBotCycle(botId: number) {
  try {
    const [state] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (!state || !state.running) return;

    // Fetch live data in parallel
    const [btcData, polyData] = await Promise.all([
      getBtcPriceData(),
      getBestBtcMarketPrice(),
    ]);

    const marketYesPrice =
      polyData.connected && polyData.yesPrice > 0.01 && polyData.yesPrice < 0.99
        ? polyData.yesPrice
        : 0.5;
    const marketId = polyData.market?.conditionId ?? "btc-sim-market";
    const trueProb = estimateTrueProb(btcData);
    const edge = trueProb - marketYesPrice;
    const evPerShare = trueProb * (1 - marketYesPrice) - (1 - trueProb) * marketYesPrice;

    const isBuyYes = edge > 0;
    const direction: "YES" | "NO" = isBuyYes ? "YES" : "NO";
    const entryPrice = isBuyYes ? marketYesPrice : 1 - marketYesPrice;
    const winProb = isBuyYes ? trueProb : 1 - trueProb;

    // ── Step 1: Close any open test positions using model fair value ──
    if (state.mode === "test") {
      await closeMaturedTestPositions(botId, state, marketYesPrice, trueProb);
    }

    // Re-read state after potential balance updates from closures
    const [freshState] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (!freshState?.running) return;

    // ── Step 2: Compute signal & sizing ──
    let signal: "BUY_YES" | "BUY_NO" | "NO_TRADE" = "NO_TRADE";
    let positionSize = 0;
    let shares = 0;
    let priceImpact = 0;

    const minBalance = freshState.sizingMode === "flat" ? freshState.flatSizeUsdc : 0.5;
    if (Math.abs(edge) >= freshState.minEdgeThreshold && freshState.balance >= minBalance) {
      signal = isBuyYes ? "BUY_YES" : "BUY_NO";

      if (freshState.sizingMode === "flat") {
        // Flat sizing: always place exactly flatSizeUsdc per trade
        positionSize = Math.min(freshState.flatSizeUsdc, freshState.balance);
        shares = entryPrice > 0 ? positionSize / entryPrice : 0;
        priceImpact = 0;
      } else {
        // Kelly sizing: quarter-Kelly formula, floored at $1 minimum (Polymarket CLOB minimum)
        const CLOB_MIN_ORDER = 1.0;
        const kellyFull = calcKelly(winProb, entryPrice);
        const kellyScaled = kellyFull * freshState.kellyFraction;
        const kellyAmount = freshState.balance * kellyScaled;
        // Use kelly amount but respect $1 floor; never exceed balance
        positionSize = Math.min(Math.max(kellyAmount, CLOB_MIN_ORDER), freshState.balance);
        shares = entryPrice > 0 ? positionSize / entryPrice : 0;
        const outcome = isBuyYes ? 0 : 1;
        const { impact } = simulatePriceImpact([0, 0], B_PARAM, outcome, shares);
        priceImpact = impact;
        if (priceImpact > Math.abs(edge) * 0.5) {
          positionSize *= 0.5;
          shares *= 0.5;
        }
      }
    }

    await db
      .update(botStateTable)
      .set({ currentMarketPrice: marketYesPrice, lastSignal: signal, lastUpdated: new Date() })
      .where(eq(botStateTable.id, botId));

    // Polymarket CLOB minimum order is $1 USDC; skip if Kelly sizing is below that
    if (signal === "NO_TRADE" || positionSize < 1.0 || shares <= 0) return;

    // ── Step 3: Only open one position at a time (test mode) ──
    if (freshState.mode === "test") {
      const openPositions = await db
        .select()
        .from(tradesTable)
        .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "test")));

      if (openPositions.length > 0) {
        // Already holding a position — wait for it to close
        return;
      }

      await openTestPosition(botId, freshState, {
        direction,
        marketPrice: marketYesPrice,
        edge,
        evPerShare,
        kellyScaledPct: positionSize / freshState.balance,
        positionSize,
        shares,
        priceImpact,
      }, btcData.currentPrice, marketId);
    } else {
      await executeLiveTrade(botId, freshState, {
        direction,
        marketPrice: marketYesPrice,
        edge,
        evPerShare,
        kellyScaledPct: positionSize / freshState.balance,
        positionSize,
        shares,
        priceImpact,
      }, btcData.currentPrice, marketId, polyData.market?.conditionId ?? null);
    }
  } catch (err) {
    console.error("Bot cycle error:", err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST MODE — Open position (paper trade at real price)
// ──────────────────────────────────────────────────────────────────────────────

async function openTestPosition(
  botId: number,
  state: { id: number; balance: number; totalTrades: number; winningTrades: number; losingTrades: number; totalPnl: number },
  trade: { direction: "YES" | "NO"; marketPrice: number; edge: number; evPerShare: number; kellyScaledPct: number; positionSize: number; shares: number; priceImpact: number },
  btcPrice: number,
  marketId: string,
) {
  const { direction, marketPrice, edge, kellyScaledPct, positionSize, shares, priceImpact } = trade;
  const trueYesProb = Math.min(0.95, Math.max(0.05, marketPrice + edge));

  await db.insert(tradesTable).values({
    direction,
    marketPrice,
    estimatedProb: trueYesProb,
    edge,
    kellyFraction: kellyScaledPct,
    positionSize,
    shares,
    priceImpact,
    exitPrice: null,
    pnl: null,
    status: "open",
    btcPriceAtEntry: btcPrice,
    marketId,
    mode: "test",
    resolvedAt: null,
  });

  // Reserve capital while position is open
  await db
    .update(botStateTable)
    .set({
      balance: state.balance - positionSize,
      lastUpdated: new Date(),
    })
    .where(eq(botStateTable.id, botId));

  console.log(`[TEST] Opened ${direction} position: $${positionSize.toFixed(3)} @ ${(marketPrice * 100).toFixed(1)}¢ YES price`);
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST MODE — Close matured positions, marked to model probability
// ──────────────────────────────────────────────────────────────────────────────
//
// Why mark-to-model instead of Polymarket price?
//   Polymarket BTC markets are ILLIQUID — the YES price barely moves between
//   30-second cycles because no one is trading it. P&L based on that price is
//   always ~$0. Instead, we exit at our model's estimated fair probability,
//   which is driven by real BTC price momentum via Kraken. This gives realistic
//   P&L: if BTC moves our way, we profit; if it moves against us, we lose.
//
//   Entry: real Polymarket market price (actual cost to open)
//   Exit:  estimateTrueProb(currentBtcData) — our model's fair value

async function closeMaturedTestPositions(
  botId: number,
  state: { id: number; balance: number; totalTrades: number; winningTrades: number; losingTrades: number; totalPnl: number },
  currentYesPrice: number,
  currentTrueProb: number,
) {
  const openPositions = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "test")));

  const now = Date.now();
  const holdMs = TEST_HOLD_CYCLES * 30_000;

  for (const pos of openPositions) {
    const age = now - pos.timestamp.getTime();
    if (age < holdMs) continue;

    // Entry price: what we actually paid per share on Polymarket
    const entryYesPrice = pos.marketPrice;
    const entryPrice = pos.direction === "YES" ? entryYesPrice : 1 - entryYesPrice;

    // Exit fair value: model probability (driven by real BTC momentum).
    // Polymarket price is illiquid and doesn't reflect short-term BTC moves.
    const exitFairValue = pos.direction === "YES" ? currentTrueProb : 1 - currentTrueProb;

    // P&L = shares × (exit fair value − entry cost per share)
    const pnl = pos.shares * (exitFairValue - entryPrice);
    const won = pnl > 0;

    // exitPrice stored in DB uses model fair value for display
    await db
      .update(tradesTable)
      .set({ status: "closed", exitPrice: exitFairValue, pnl, resolvedAt: new Date() })
      .where(eq(tradesTable.id, pos.id));

    const returnedCapital = pos.positionSize + pnl;
    await db
      .update(botStateTable)
      .set({
        balance: state.balance + returnedCapital,
        totalTrades: state.totalTrades + 1,
        winningTrades: won ? state.winningTrades + 1 : state.winningTrades,
        losingTrades: won ? state.losingTrades : state.losingTrades + 1,
        totalPnl: state.totalPnl + pnl,
        lastUpdated: new Date(),
      })
      .where(eq(botStateTable.id, botId));

    state.balance += returnedCapital;
    state.totalTrades += 1;
    state.totalPnl += pnl;
    if (won) state.winningTrades += 1; else state.losingTrades += 1;

    console.log(
      `[TEST] Closed ${pos.direction} | entry ${(entryPrice * 100).toFixed(1)}¢ ` +
      `→ model exit ${(exitFairValue * 100).toFixed(1)}¢ | ` +
      `BTC trueProb ${(currentTrueProb * 100).toFixed(1)}% | ` +
      `P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`
    );
  }
}

async function forceCloseOpenTestPositions(botId: number) {
  const state = await ensureBotState();
  const [polyData, btcData] = await Promise.all([
    getBestBtcMarketPrice().catch(() => null),
    getBtcPriceData().catch(() => null),
  ]);
  const currentYesPrice = polyData?.yesPrice ?? 0.5;
  const currentTrueProb = btcData ? estimateTrueProb(btcData) : 0.5;
  await closeMaturedTestPositions(botId, state, currentYesPrice, currentTrueProb);
}

// ──────────────────────────────────────────────────────────────────────────────
// LIVE ORDER EXECUTION
// ──────────────────────────────────────────────────────────────────────────────

async function executeLiveTrade(
  botId: number,
  state: { id: number; balance: number; totalTrades: number; winningTrades: number; losingTrades: number; totalPnl: number },
  trade: { direction: "YES" | "NO"; marketPrice: number; edge: number; evPerShare: number; kellyScaledPct: number; positionSize: number; shares: number; priceImpact: number },
  btcPrice: number,
  marketId: string,
  conditionId: string | null,
) {
  const { direction, marketPrice, edge, kellyScaledPct, positionSize, shares, priceImpact } = trade;

  const orderSize = Math.max(positionSize, MIN_LIVE_ORDER_USDC);
  if (orderSize > state.balance) {
    console.log(`[LIVE] Skipping — order size $${orderSize.toFixed(2)} > balance $${state.balance.toFixed(2)}`);
    return;
  }

  let tokenId: string | null = null;
  if (conditionId) tokenId = await getClobTokenId(conditionId, direction);

  if (!tokenId) {
    console.error(`[LIVE] Could not get CLOB token ID for ${direction} on ${conditionId}`);
    return;
  }

  const limitPrice = direction === "YES" ? marketPrice : 1 - marketPrice;
  const trueYesProb = Math.min(0.95, Math.max(0.05, marketPrice + edge));
  const tradeCtx = {
    direction, marketPrice, estimatedProb: trueYesProb, edge,
    kellyScaledPct, positionSize: orderSize, shares, priceImpact, btcPrice, marketId,
  };

  // ── Browser-relay mode: no proxy configured → queue for browser to submit ──
  if (!hasProxy()) {
    console.log(`[LIVE] No proxy — queuing ${direction} order for browser relay`);
    try {
      const prepared = await prepareOrderForBrowser({ tokenId, side: "BUY", price: limitPrice, sizeUsdc: orderSize });
      browserOrderQueue.push({ prepared, botId, tradeContext: tradeCtx, queuedAt: Date.now() });
      await db.update(botStateTable).set({
        lastSignal: `LIVE ${direction} — awaiting browser relay ($${orderSize.toFixed(2)})`,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
    } catch (err) {
      console.error("[LIVE] Failed to prepare browser order:", err);
      await db.update(botStateTable).set({
        lastSignal: `ORDER PREP FAILED: ${String(err).substring(0, 60)}`,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
    }
    return;
  }

  // ── Proxy mode: place directly from server ──
  console.log(`[LIVE] Placing ${direction} order via proxy: $${orderSize.toFixed(2)} @ ${(limitPrice * 100).toFixed(1)}¢`);
  const result = await placeOrder({ tokenId, side: "BUY", price: limitPrice, sizeUsdc: orderSize });

  if (result.success) {
    await db.insert(tradesTable).values({
      direction, marketPrice, estimatedProb: trueYesProb,
      edge, kellyFraction: kellyScaledPct,
      positionSize: orderSize, shares, priceImpact,
      exitPrice: null, pnl: null, status: "open",
      btcPriceAtEntry: btcPrice,
      marketId: result.orderId ? `${marketId}::${result.orderId}` : marketId,
      resolvedAt: null, mode: "live",
    });
    await db.update(botStateTable).set({
      balance: state.balance - orderSize,
      totalTrades: state.totalTrades + 1,
      lastSignal: `LIVE ${direction} — $${orderSize.toFixed(2)} placed`,
      lastUpdated: new Date(),
    }).where(eq(botStateTable.id, botId));
    console.log(`[LIVE] Order placed OK: ${result.orderId}`);
  } else {
    const errorMsg = result.errorMessage ?? "";
    console.error(`[LIVE] Order failed: ${errorMsg}`);
    const isGeoblock = errorMsg.includes("restricted") || errorMsg.includes("geoblock") || errorMsg.includes("region");
    if (isGeoblock) {
      console.warn("[LIVE] Proxy geoblocked — disabling proxy and switching to browser relay for this order.");
      setProxyUrl(null); // disable proxy for the rest of the session
      // Queue the same order via browser relay so the browser can submit it
      try {
        const prepared = await prepareOrderForBrowser({ tokenId, side: "BUY", price: limitPrice, sizeUsdc: orderSize });
        browserOrderQueue.push({ prepared, botId, tradeContext: tradeCtx, queuedAt: Date.now() });
        await db.update(botStateTable).set({
          lastSignal: `LIVE ${direction} — proxy geoblocked, awaiting browser relay ($${orderSize.toFixed(2)})`,
          lastUpdated: new Date(),
        }).where(eq(botStateTable.id, botId));
        console.log("[LIVE] Queued order for browser relay after proxy geoblock.");
      } catch (err) {
        console.error("[LIVE] Failed to prepare browser relay order after geoblock:", err);
        await db.update(botStateTable).set({
          lastSignal: "BLOCKED: Geoblock — keep dashboard open for browser-relay.",
          lastUpdated: new Date(),
        }).where(eq(botStateTable.id, botId));
      }
    } else {
      await db.update(botStateTable).set({
        lastSignal: `ORDER FAILED: ${errorMsg.substring(0, 60)}`,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MARKET ANALYSIS (dashboard)
// ──────────────────────────────────────────────────────────────────────────────

export async function getMarketAnalysis() {
  const state = await ensureBotState();
  const [btcData, polyData] = await Promise.all([getBtcPriceData(), getBestBtcMarketPrice()]);

  const trueProb = estimateTrueProb(btcData);
  const marketYesPrice =
    polyData.connected && polyData.yesPrice > 0.01 && polyData.yesPrice < 0.99
      ? polyData.yesPrice : 0.5;

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
    const { impact } = simulatePriceImpact([0, 0], B_PARAM, isBuyYes ? 0 : 1, shares);
    priceImpact = impact;
  }

  return {
    marketId: polyData.market?.conditionId ?? "btc-sim-market",
    marketTitle: polyData.market?.question ?? "Bitcoin Price Market (simulated)",
    currentPrice: marketYesPrice,
    liquidityParam: B_PARAM,
    qYes: 0, qNo: 0,
    btcCurrentPrice: btcData.currentPrice,
    btcPriceChange5m: btcData.change5m,
    btcPriceChange1h: btcData.change1h,
    estimatedTrueProb: trueProb,
    edge, signal, evPerShare,
    recommendedDirection: (edge > 0 ? "YES" : edge < 0 ? "NO" : null) as "YES" | "NO" | null,
    kellySize: positionSize,
    priceImpact,
    analysisTime: new Date().toISOString(),
  };
}

export { getConnectionStatus };
