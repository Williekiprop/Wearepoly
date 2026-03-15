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
import { getBtcPriceData, estimate5mUpProb } from "./btcPrice.js";
import { fetchCurrent5mMarket, getConnectionStatus, type FiveMinMarket } from "./polymarketClient.js";
import { placeOrder, prepareOrderForBrowser, getClobTokenId, getWalletBalance, type PreparedBrowserOrder } from "./polymarketOrder.js";
import { hasProxy, setProxyUrl, markProxyGeoblocked } from "./proxiedFetch.js";

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
    orderSide: "BUY" | "SELL";    // distinguishes entry vs exit orders
    tradeId?: number;              // SELL only: tradesTable row ID to close on confirm
    tokenId?: string;              // token being traded (for display/future use)
    entryPrice?: number;           // SELL only: original entry price per share (for PnL)
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

// Track which open live trade IDs already have a SELL order queued/submitted
// so we never double-close the same position.
const pendingSellTradeIds = new Set<number>();

// Track which 5m window-end timestamps we've ALREADY attempted entry on.
// Prevents re-queuing after a failed attempt within the same 5-minute window.
// Cleared automatically when the window rolls over.
const attemptedWindowEnds = new Set<number>();

// Balance refresh: fetch on-chain wallet balance every N cycles and sync to DB
let _balanceRefreshCounter = 0;
const BALANCE_REFRESH_EVERY_N_CYCLES = 2; // every ~60 seconds

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
  ctx: PendingBrowserOrder["tradeContext"] & { botId: number },
  actualShares?: number, // exact tokens received/given as reported by CLOB (overrides estimate)
  clobStatus?: string,   // "matched" = settled on-chain with tokens; "live" = order still in book
): Promise<void> {
  const { botId, orderSide, tradeId, entryPrice, direction, marketPrice, estimatedProb, edge, kellyScaledPct,
    positionSize, shares: estimatedShares, priceImpact, btcPrice, marketId } = ctx;

  // For BUY: use actual tokens received from CLOB; 0 if order is still "live" in book (not matched yet)
  // For SELL: actualShares from CLOB is USDC received; use estimatedShares for PnL calculation
  const isMatched = !clobStatus || clobStatus === "matched"; // default to matched if unknown
  const shares = orderSide === "BUY"
    ? (isMatched ? (actualShares ?? estimatedShares) : (actualShares ?? 0))
    : estimatedShares;

  if (success && orderId) {
    if (orderSide === "SELL" && tradeId != null) {
      // ── SELL confirmed: close the position, record PnL, refill balance from chain ──
      pendingSellTradeIds.delete(tradeId);
      const exitPrice = marketPrice; // price at which we sold
      const entryPriceUsed = entryPrice ?? exitPrice;
      const pnl = shares * (exitPrice - entryPriceUsed);
      const won = pnl > 0;

      await db.update(tradesTable).set({
        status: "closed",
        exitPrice,
        pnl,
        resolvedAt: new Date(),
      }).where(eq(tradesTable.id, tradeId));

      // Refetch real wallet balance so any on-chain profit flows back into bot budget
      const walletBalance = await getWalletBalance();
      const [state] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
      if (state) {
        const newBalance = walletBalance !== null && walletBalance > 0 ? walletBalance : state.balance + positionSize + pnl;
        await db.update(botStateTable).set({
          balance: newBalance,
          totalTrades: state.totalTrades + 1,
          winningTrades: won ? state.winningTrades + 1 : state.winningTrades,
          losingTrades: won ? state.losingTrades : state.losingTrades + 1,
          totalPnl: state.totalPnl + pnl,
          lastSignal: `LIVE SELL ${direction} — P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} | wallet $${newBalance.toFixed(2)}`,
          lastUpdated: new Date(),
        }).where(eq(botStateTable.id, botId));
      }
      console.log(`[LIVE/BROWSER] SELL confirmed ${orderId} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} | wallet: $${walletBalance?.toFixed(2) ?? "?"}`);
    } else {
      // ── BUY confirmed: open new position row, deduct balance ──
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
          lastSignal: `LIVE BUY ${direction} — $${positionSize.toFixed(2)} placed`,
          lastUpdated: new Date(),
        }).where(eq(botStateTable.id, botId));
      }
      console.log(`[LIVE/BROWSER] BUY ${isMatched ? "MATCHED" : "LIVE(pending)"}: ${orderId} | shares=${shares.toFixed(2)} | balance deducted $${positionSize.toFixed(4)}`);
    }
  } else {
    if (orderSide === "SELL" && tradeId != null) {
      pendingSellTradeIds.delete(tradeId);
      // If SELL fails due to insufficient balance (tokens not in wallet), cancel the position
      // rather than retrying forever. This handles "live" (unmatched) orders that never filled.
      const errLower = (errorMessage ?? "").toLowerCase();
      if (errLower.includes("not enough balance") || errLower.includes("allowance")) {
        await db.update(tradesTable).set({ status: "cancelled", resolvedAt: new Date() }).where(eq(tradesTable.id, tradeId));
        // Refetch wallet balance to sync after failed sell attempt
        const walletBalance = await getWalletBalance();
        const [state] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
        if (state && walletBalance !== null && walletBalance > 0) {
          await db.update(botStateTable).set({ balance: walletBalance, lastUpdated: new Date() }).where(eq(botStateTable.id, botId));
        }
        console.warn(`[LIVE/BROWSER] SELL failed (no balance) — trade #${tradeId} cancelled, wallet synced to $${walletBalance?.toFixed(2)}`);
      }
    }
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

// How many 30s cycles to hold a LIVE position before selling back to market
// 4 cycles = 2 minutes.  Gives edge time to realise without tying up capital forever.
const LIVE_HOLD_CYCLES = 4; // 2 minutes

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
      minEdgeThreshold: 0.003,
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

/** Manually fetch on-chain wallet balance and sync to DB. Returns new balance or null. */
export async function syncWalletBalance(): Promise<number | null> {
  const state = await ensureBotState();
  if (state.mode !== "live") return null;
  const onChainBalance = await getWalletBalance();
  if (onChainBalance !== null && onChainBalance > 0) {
    await db.update(botStateTable).set({ balance: onChainBalance, lastUpdated: new Date() })
      .where(eq(botStateTable.id, state.id));
    console.log(`[LIVE] Manual balance sync: $${onChainBalance.toFixed(4)}`);
    return onChainBalance;
  }
  return null;
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
      minEdgeThreshold: opts.minEdgeThreshold ?? 0.001,
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

export async function setMinEdgeThreshold(threshold: number) {
  const state = await ensureBotState();
  await db
    .update(botStateTable)
    .set({ minEdgeThreshold: threshold, lastUpdated: new Date() })
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

/**
 * Called at server startup: if the DB says the bot was running before the
 * server restarted, resume polling without resetting trades/balance.
 */
export async function autoResumeBot() {
  const state = await ensureBotState();
  if (state.running && pollingInterval === null) {
    console.log(`[BOT] Auto-resuming ${state.mode.toUpperCase()} bot (balance $${state.balance?.toFixed(2)}) after restart`);
    startPolling(state.id);
  }
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

// Encode 5m market info into the marketId field so we can recover it later
function encode5mMarketId(market: FiveMinMarket): string {
  return `btc5m:${market.windowEnd}:${market.conditionId}`;
}
function decode5mMarketId(marketId: string): { windowEnd: number; conditionId: string } | null {
  const parts = marketId.split(":");
  if (parts[0] !== "btc5m" || parts.length < 3) return null;
  return { windowEnd: parseInt(parts[1]), conditionId: parts.slice(2).join(":") };
}

async function runBotCycle(botId: number) {
  try {
    const [state] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (!state || !state.running) return;

    // ── Periodic on-chain wallet balance sync (LIVE mode only) ──
    if (state.mode === "live") {
      _balanceRefreshCounter++;
      if (_balanceRefreshCounter % BALANCE_REFRESH_EVERY_N_CYCLES === 0) {
        const onChainBalance = await getWalletBalance();
        if (onChainBalance !== null && onChainBalance > 0) {
          const diff = Math.abs(onChainBalance - state.balance);
          if (diff > 0.01) { // only update if meaningfully different (> 1¢)
            console.log(`[LIVE] Balance sync: DB $${state.balance.toFixed(4)} → on-chain $${onChainBalance.toFixed(4)}`);
            await db.update(botStateTable).set({
              balance: onChainBalance,
              lastUpdated: new Date(),
            }).where(eq(botStateTable.id, botId));
          }
        }
      }
    }

    // Fetch live data in parallel
    const [btcData, market5m] = await Promise.all([
      getBtcPriceData(),
      fetchCurrent5mMarket(),
    ]);

    if (!market5m) {
      console.log("[BOT] Could not fetch 5m market — retrying next cycle");
      return;
    }

    // ── Step 1: Resolve / manage open positions ──
    if (state.mode === "test") {
      await resolve5mTestPositions(botId, btcData.currentPrice);
    } else {
      await resolve5mLivePositions(botId);
    }

    // Re-read state after potential balance updates from closures
    const [freshState] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (!freshState?.running) return;

    // ── Step 2: 5m market signal ──
    // prob_up = our estimated probability that BTC ends this window HIGHER
    const probUp = estimate5mUpProb(btcData);
    const upPrice = market5m.upPrice;
    const downPrice = market5m.downPrice;

    // Edge: positive means BUY UP, negative means BUY DOWN
    const edgeUp = probUp - upPrice;
    const isBuyUp = edgeUp > 0;
    const direction: "YES" | "NO" = isBuyUp ? "YES" : "NO"; // YES=UP, NO=DOWN in DB
    const entryPrice = isBuyUp ? upPrice : downPrice;
    const winProb = isBuyUp ? probUp : 1 - probUp;
    const edge = isBuyUp ? edgeUp : -edgeUp; // always positive

    // Skip if <60 seconds left in window — too late to get a good fill
    const MIN_SECS_TO_ENTER = 60;
    const tooLate = market5m.secondsRemaining < MIN_SECS_TO_ENTER;

    let signal: "BUY_YES" | "BUY_NO" | "NO_TRADE" = "NO_TRADE";
    let positionSize = 0;
    let shares = 0;

    const minBalance = freshState.sizingMode === "flat" ? freshState.flatSizeUsdc : 0.5;
    if (!tooLate && edge >= freshState.minEdgeThreshold && freshState.balance >= minBalance) {
      signal = isBuyUp ? "BUY_YES" : "BUY_NO";

      if (freshState.sizingMode === "flat") {
        positionSize = Math.min(freshState.flatSizeUsdc, freshState.balance);
        shares = entryPrice > 0 ? positionSize / entryPrice : 0;
      } else {
        const CLOB_MIN_ORDER = 1.0;
        const kellyFull = calcKelly(winProb, entryPrice);
        const kellyScaled = kellyFull * freshState.kellyFraction;
        positionSize = Math.min(Math.max(freshState.balance * kellyScaled, CLOB_MIN_ORDER), freshState.balance);
        shares = entryPrice > 0 ? positionSize / entryPrice : 0;
      }
    }

    // Always log signal so user can see what the model is doing
    const upPct    = (upPrice * 100).toFixed(1);
    const downPct  = (downPrice * 100).toFixed(1);
    const probUpPct = (probUp * 100).toFixed(1);
    const edgePct  = (edge * 100).toFixed(2);
    const secStr   = market5m.secondsRemaining > 0 ? `${market5m.secondsRemaining}s left` : "RESOLVED";
    const chg1m    = btcData.change1m >= 0 ? `+${btcData.change1m.toFixed(3)}%` : `${btcData.change1m.toFixed(3)}%`;
    if (signal === "NO_TRADE") {
      const reason = tooLate ? "TOO_LATE" : `edge ${edgePct}% < threshold ${(freshState.minEdgeThreshold*100).toFixed(1)}%`;
      console.log(`[5M] NO_TRADE | UP=${upPct}¢ DOWN=${downPct}¢ model=${probUpPct}% btc1m=${chg1m} | ${reason} | ${secStr}`);
    } else {
      const dir = isBuyUp ? "BUY_UP" : "BUY_DOWN";
      console.log(`[5M] ${dir} | UP=${upPct}¢ DOWN=${downPct}¢ model=${probUpPct}% btc1m=${chg1m} edge=+${edgePct}% size=$${positionSize.toFixed(2)} | ${secStr}`);
    }

    await db
      .update(botStateTable)
      .set({ currentMarketPrice: upPrice, lastSignal: signal, lastUpdated: new Date() })
      .where(eq(botStateTable.id, botId));

    if (signal === "NO_TRADE" || positionSize < 1.0 || shares <= 0) return;

    const marketId = encode5mMarketId(market5m);
    const evPerShare = winProb * (1 - entryPrice) - (1 - winProb) * entryPrice;

    // ── Step 3: Open new position (one per window) ──
    if (freshState.mode === "test") {
      const openPositions = await db.select().from(tradesTable)
        .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "test")));
      if (openPositions.length > 0) return;

      await openTestPosition(botId, freshState, {
        direction, marketPrice: upPrice, edge, evPerShare,
        kellyScaledPct: positionSize / freshState.balance, positionSize, shares, priceImpact: 0,
      }, btcData.currentPrice, marketId);
    } else {
      const openLivePositions = await db.select().from(tradesTable)
        .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "live")));
      if (openLivePositions.length > 0) {
        const pos = openLivePositions[0];
        const info = decode5mMarketId(pos.marketId ?? "");
        const secsLeft = info ? Math.max(0, info.windowEnd - Math.floor(Date.now() / 1000)) : 0;
        console.log(`[LIVE] Holding ${pos.direction === "YES" ? "UP" : "DOWN"} | window closes in ${secsLeft}s`);
        return;
      }
      const hasPendingBuy = browserOrderQueue.some(o => o.botId === botId && o.tradeContext.orderSide === "BUY");
      if (hasPendingBuy) {
        console.log("[LIVE] Skipping — BUY already queued, awaiting relay");
        return;
      }

      // Only attempt entry ONCE per 5-minute window — prevents retry-spam after relay failure
      if (attemptedWindowEnds.has(market5m.windowEnd)) {
        console.log(`[LIVE] Already attempted window ${new Date(market5m.windowEnd * 1000).toISOString()} — waiting for next window`);
        return;
      }
      attemptedWindowEnds.add(market5m.windowEnd);
      // Prune old window entries (keep only last 5)
      if (attemptedWindowEnds.size > 5) {
        const sorted = [...attemptedWindowEnds].sort((a, b) => a - b);
        for (let i = 0; i < sorted.length - 5; i++) attemptedWindowEnds.delete(sorted[i]);
      }

      const tokenId = direction === "YES" ? market5m.upTokenId : market5m.downTokenId;
      await executeLiveTrade(botId, freshState, {
        direction, marketPrice: upPrice, edge, evPerShare,
        kellyScaledPct: positionSize / freshState.balance, positionSize, shares, priceImpact: 0,
      }, btcData.currentPrice, marketId, market5m.conditionId, tokenId);
    }
  } catch (err) {
    console.error("Bot cycle error:", err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 5-MINUTE RESOLUTION — TEST mode
// After windowEnd, determine UP/DOWN winner by comparing current BTC vs entry.
// ──────────────────────────────────────────────────────────────────────────────

async function resolve5mTestPositions(botId: number, currentBtcPrice: number) {
  const openPositions = await db
    .select().from(tradesTable)
    .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "test")));

  const nowSec = Math.floor(Date.now() / 1000);

  for (const pos of openPositions) {
    const info = decode5mMarketId(pos.marketId ?? "");
    if (!info) continue; // legacy trade, skip

    if (nowSec < info.windowEnd) continue; // window not over yet

    // Determine winner: UP wins if BTC price >= price at entry
    const entryBtc = pos.btcPriceAtEntry ?? currentBtcPrice;
    const upWon = currentBtcPrice >= entryBtc;

    // Did we pick the winner?
    const weBoughtUp = pos.direction === "YES";
    const weWon = weBoughtUp ? upWon : !upWon;

    const entryPrice = weBoughtUp ? pos.marketPrice : 1 - pos.marketPrice;
    const exitValue = weWon ? 1.0 : 0.0;
    const pnl = pos.shares * (exitValue - entryPrice);
    const returnedCapital = pos.positionSize + pnl; // 0 if lost, 2x if won big

    const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (!st) continue;

    await db.update(tradesTable).set({
      status: "closed", exitPrice: exitValue, pnl, resolvedAt: new Date(),
    }).where(eq(tradesTable.id, pos.id));

    await db.update(botStateTable).set({
      balance: st.balance + returnedCapital,
      totalTrades: st.totalTrades + 1,
      winningTrades: weWon ? st.winningTrades + 1 : st.winningTrades,
      losingTrades: weWon ? st.losingTrades : st.losingTrades + 1,
      totalPnl: st.totalPnl + pnl,
      lastUpdated: new Date(),
    }).where(eq(botStateTable.id, botId));

    const direction = weBoughtUp ? "UP" : "DOWN";
    const winner = upWon ? "UP" : "DOWN";
    const result = weWon ? "WON" : "LOST";
    console.log(
      `[5M] ${result} ${direction} position | BTC ${entryBtc.toFixed(0)} → ${currentBtcPrice.toFixed(0)} ` +
      `(winner: ${winner}) | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 5-MINUTE RESOLUTION — LIVE mode
// After windowEnd, query the CLOB to see which side won, then settle P&L.
// ──────────────────────────────────────────────────────────────────────────────

async function resolve5mLivePositions(botId: number) {
  const openLive = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "live")));

  const nowSec = Math.floor(Date.now() / 1000);

  for (const pos of openLive) {
    if (pendingSellTradeIds.has(pos.id)) continue;

    const info = decode5mMarketId(pos.marketId ?? "");
    if (!info) continue;

    if (nowSec < info.windowEnd) continue; // window not done yet

    // Query CLOB to see who won
    try {
      const clobRes = await import("./proxiedFetch.js").then(m =>
        m.polyFetch(`https://clob.polymarket.com/markets/${info.conditionId}`, {
          signal: AbortSignal.timeout(8000),
        })
      );
      if (!clobRes.ok) continue;

      const clobData = await clobRes.json() as {
        tokens: Array<{ token_id: string; outcome: string; price: number; winner: boolean }>;
      };

      const upToken = clobData.tokens?.find(t => t.outcome.toLowerCase() === "up");
      const downToken = clobData.tokens?.find(t => t.outcome.toLowerCase() === "down");

      const upWon = upToken?.winner === true;
      const downWon = downToken?.winner === true;

      if (!upWon && !downWon) {
        // Market not yet resolved on-chain
        continue;
      }

      const weBoughtUp = pos.direction === "YES";
      const weWon = weBoughtUp ? upWon : downWon;

      const entryPrice = weBoughtUp ? pos.marketPrice : 1 - pos.marketPrice;
      const exitValue = weWon ? 1.0 : 0.0;
      const pnl = pos.shares * (exitValue - entryPrice);
      const returnedCapital = pos.positionSize + pnl;

      const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
      if (!st) continue;

      await db.update(tradesTable).set({
        status: "closed", exitPrice: exitValue, pnl, resolvedAt: new Date(),
      }).where(eq(tradesTable.id, pos.id));

      await db.update(botStateTable).set({
        balance: st.balance + returnedCapital,
        totalTrades: st.totalTrades + 1,
        winningTrades: weWon ? st.winningTrades + 1 : st.winningTrades,
        losingTrades: weWon ? st.losingTrades : st.losingTrades + 1,
        totalPnl: st.totalPnl + pnl,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));

      const direction = weBoughtUp ? "UP" : "DOWN";
      const winner = upWon ? "UP" : "DOWN";
      const result = weWon ? "WON" : "LOST";
      console.log(`[LIVE 5M] ${result} ${direction} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);

      // Sync wallet balance after resolution
      const walletBal = await getWalletBalance();
      if (walletBal !== null && walletBal > 0) {
        await db.update(botStateTable).set({ balance: walletBal, lastUpdated: new Date() })
          .where(eq(botStateTable.id, botId));
      }
    } catch (err) {
      console.error(`[LIVE 5M] resolve error for trade #${pos.id}:`, err);
    }
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

  const dirLabel = direction === "YES" ? "UP" : "DOWN";
  const entryPriceForLog = direction === "YES" ? marketPrice : 1 - marketPrice;
  console.log(`[5M TEST] Opened ${dirLabel} position: $${positionSize.toFixed(3)} @ ${(entryPriceForLog * 100).toFixed(1)}¢`);
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
  const btcData = await getBtcPriceData().catch(() => null);
  const currentBtcPrice = btcData?.currentPrice ?? 0;
  // Force-close by treating all open positions as if window has ended
  const openPositions = await db
    .select().from(tradesTable)
    .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "test")));
  for (const pos of openPositions) {
    const entryBtc = pos.btcPriceAtEntry ?? currentBtcPrice;
    const upWon = currentBtcPrice >= entryBtc;
    const weBoughtUp = pos.direction === "YES";
    const weWon = weBoughtUp ? upWon : !upWon;
    const entryPrice = weBoughtUp ? pos.marketPrice : 1 - pos.marketPrice;
    const exitValue = weWon ? 1.0 : 0.0;
    const pnl = pos.shares * (exitValue - entryPrice);
    await db.update(tradesTable).set({ status: "closed", exitPrice: exitValue, pnl, resolvedAt: new Date() })
      .where(eq(tradesTable.id, pos.id));
    const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (st) {
      await db.update(botStateTable).set({
        balance: st.balance + pos.positionSize + pnl,
        totalTrades: st.totalTrades + 1,
        winningTrades: weWon ? st.winningTrades + 1 : st.winningTrades,
        losingTrades: weWon ? st.losingTrades : st.losingTrades + 1,
        totalPnl: st.totalPnl + pnl,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// LIVE MODE — Close mature positions by placing SELL orders
// ──────────────────────────────────────────────────────────────────────────────

async function closeMatureLivePositions(
  botId: number,
  currentYesPrice: number,
  conditionId: string | null,
): Promise<void> {
  const openLive = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "live")));

  const now = Date.now();
  // Exit triggers (all time-based minimums; price-based targets take priority)
  const MIN_HOLD_MS  = LIVE_HOLD_CYCLES * 30_000;    // 2 min: never exit before this
  const MAX_HOLD_MS  = 30 * 60_000;                  // 30 min: always exit by this point
  const PROFIT_TARGET = 0.10;   // +10% price move from entry → take profit
  const STOP_LOSS     = -0.20;  // -20% price move from entry → cut loss

  for (const pos of openLive) {
    const age = now - pos.timestamp.getTime();
    if (pendingSellTradeIds.has(pos.id)) continue;    // already queued

    if (pos.shares < 0.1) {
      // "live" (un-matched) order — tokens not in wallet; cancel instead of selling
      await db.update(tradesTable).set({ status: "cancelled", resolvedAt: new Date() }).where(eq(tradesTable.id, pos.id));
      console.log(`[LIVE] Trade #${pos.id} had 0 shares (unmatched), marking cancelled`);
      continue;
    }

    // Determine current sell price vs entry price
    const sellPrice  = pos.direction === "YES" ? currentYesPrice : 1 - currentYesPrice;
    const entryPrice = pos.direction === "YES" ? pos.marketPrice  : 1 - pos.marketPrice;
    const priceChange = entryPrice > 0 ? (sellPrice - entryPrice) / entryPrice : 0;

    // Evaluate exit conditions
    const hitMinHold    = age >= MIN_HOLD_MS;
    const hitMaxHold    = age >= MAX_HOLD_MS;
    const hitProfitTgt  = hitMinHold && priceChange >= PROFIT_TARGET;
    const hitStopLoss   = hitMinHold && priceChange <= STOP_LOSS;

    if (!hitProfitTgt && !hitStopLoss && !hitMaxHold) {
      // Not ready to exit — log current status every cycle for visibility
      const pctChange = (priceChange * 100).toFixed(1);
      const pctTarget = (PROFIT_TARGET * 100).toFixed(0);
      console.log(
        `[LIVE] Holding trade #${pos.id} | age ${Math.round(age/1000)}s` +
        ` | entry ${(entryPrice*100).toFixed(2)}¢ → now ${(sellPrice*100).toFixed(2)}¢` +
        ` (${priceChange >= 0 ? "+" : ""}${pctChange}%) | target ≥+${pctTarget}%`
      );
      continue;
    }

    const exitReason = hitProfitTgt ? "PROFIT_TARGET" : hitStopLoss ? "STOP_LOSS" : "MAX_HOLD";
    console.log(
      `[LIVE] Exiting trade #${pos.id} — ${exitReason}` +
      ` | price ${(entryPrice*100).toFixed(2)}¢ → ${(sellPrice*100).toFixed(2)}¢` +
      ` (${priceChange >= 0 ? "+" : ""}${(priceChange*100).toFixed(1)}%)`
    );

    if (!conditionId) {
      console.warn("[LIVE] Cannot close position — no conditionId available");
      continue;
    }

    const tokenId = await getClobTokenId(conditionId, pos.direction);
    if (!tokenId) {
      console.error(`[LIVE] Cannot get tokenId for SELL of ${pos.direction}`);
      continue;
    }

    // Prepare SELL order using exact shares held
    try {
      const prepared = await prepareOrderForBrowser({
        tokenId,
        side: "SELL",
        price: sellPrice,
        sizeUsdc: pos.shares * sellPrice,
        sizeTokens: pos.shares,
      });

      pendingSellTradeIds.add(pos.id);
      browserOrderQueue.push({
        prepared,
        botId,
        tradeContext: {
          orderSide: "SELL",
          tradeId: pos.id,
          tokenId,
          entryPrice,
          direction: pos.direction,
          marketPrice: currentYesPrice,
          estimatedProb: currentYesPrice,
          edge: 0,
          kellyScaledPct: 0,
          positionSize: pos.positionSize,
          shares: pos.shares,
          priceImpact: 0,
          btcPrice: 0,
          marketId: pos.marketId,
        },
        queuedAt: Date.now(),
      });

      const [state] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
      if (state) {
        await db.update(botStateTable).set({
          lastSignal: `LIVE SELL ${pos.direction} — closing ${pos.shares.toFixed(2)} shares @ ${(sellPrice * 100).toFixed(1)}¢`,
          lastUpdated: new Date(),
        }).where(eq(botStateTable.id, botId));
      }

      console.log(`[LIVE] Queued SELL for trade #${pos.id}: ${pos.shares.toFixed(2)} ${pos.direction} tokens @ ${(sellPrice * 100).toFixed(1)}¢ (held ${Math.round(age / 1000)}s)`);
    } catch (err) {
      console.error(`[LIVE] Failed to prepare SELL for trade #${pos.id}:`, err);
    }
  }
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
  preloadedTokenId?: string,
) {
  const { direction, marketPrice, edge, kellyScaledPct, positionSize, shares, priceImpact } = trade;

  const orderSize = Math.max(positionSize, MIN_LIVE_ORDER_USDC);
  if (orderSize > state.balance) {
    console.log(`[LIVE] Skipping — order size $${orderSize.toFixed(2)} > balance $${state.balance.toFixed(2)}`);
    return;
  }

  let tokenId: string | null = preloadedTokenId ?? null;
  if (!tokenId && conditionId) tokenId = await getClobTokenId(conditionId, direction);

  if (!tokenId) {
    console.error(`[LIVE] Could not get CLOB token ID for ${direction} on ${conditionId}`);
    return;
  }

  const limitPrice = direction === "YES" ? marketPrice : 1 - marketPrice;
  const trueYesProb = Math.min(0.95, Math.max(0.05, marketPrice + edge));
  const tradeCtx = {
    orderSide: "BUY" as const,
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
      console.warn("[LIVE] Proxy geoblocked — suspending for 5 min (will auto-retry when VPN region changes).");
      markProxyGeoblocked(); // 5-min cooldown; proxy URL preserved for auto-retry
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
  const [btcData, market5m] = await Promise.all([getBtcPriceData(), fetchCurrent5mMarket()]);

  const upPrice = market5m?.upPrice ?? 0.5;
  const downPrice = market5m?.downPrice ?? 0.5;
  const probUp = estimate5mUpProb(btcData);

  const edgeUp = probUp - upPrice;
  const isBuyUp = edgeUp > 0;
  const edge = isBuyUp ? edgeUp : -edgeUp;
  const entryPrice = isBuyUp ? upPrice : downPrice;
  const winProb = isBuyUp ? probUp : 1 - probUp;
  const evPerShare = winProb * (1 - entryPrice) - (1 - winProb) * entryPrice;

  const tooLate = (market5m?.secondsRemaining ?? 0) < 60;
  let signal: "BUY_YES" | "BUY_NO" | "NO_TRADE" = "NO_TRADE";
  let positionSize = 0;

  if (!tooLate && edge >= state.minEdgeThreshold) {
    signal = isBuyUp ? "BUY_YES" : "BUY_NO";
    if (state.sizingMode === "flat") {
      positionSize = Math.min(state.flatSizeUsdc, state.balance);
    } else {
      const kellyFull = calcKelly(winProb, entryPrice);
      positionSize = Math.min(state.balance * kellyFull * state.kellyFraction, state.balance);
    }
  }

  return {
    // 5m market data
    marketId: market5m?.conditionId ?? "btc-5m-sim",
    marketTitle: market5m?.title ?? "BTC Up or Down — 5-minute window",
    upPrice,
    downPrice,
    upTokenId: market5m?.upTokenId ?? null,
    downTokenId: market5m?.downTokenId ?? null,
    windowEnd: market5m?.windowEnd ?? null,
    secondsRemaining: market5m?.secondsRemaining ?? null,
    windowResolved: market5m?.resolved ?? false,
    // Compat fields (currentPrice = UP price for existing dashboard panels)
    currentPrice: upPrice,
    liquidityParam: B_PARAM,
    qYes: 0, qNo: 0,
    // BTC
    btcCurrentPrice: btcData.currentPrice,
    btcPriceChange1m: btcData.change1m,
    btcPriceChange5m: btcData.change5m,
    btcPriceChange1h: btcData.change1h,
    // Model
    estimatedTrueProb: probUp,
    edge: isBuyUp ? edgeUp : -edgeUp, // signed: + means BUY_UP, - means BUY_DOWN
    signal, evPerShare,
    recommendedDirection: (isBuyUp ? "YES" : "NO") as "YES" | "NO",
    kellySize: positionSize,
    priceImpact: 0,
    minEdgeThreshold: state.minEdgeThreshold,
    analysisTime: new Date().toISOString(),
  };
}

export { getConnectionStatus };
