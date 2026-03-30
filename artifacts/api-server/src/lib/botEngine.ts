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
import { getBtcPriceData, estimate5mUpProb, startBtcWebSocket } from "./btcPrice.js";
import { fetchCurrent5mMarket, getConnectionStatus, type FiveMinMarket } from "./polymarketClient.js";
import { placeOrder, prepareOrderForBrowser, getClobTokenId, getWalletBalance, redeemWinningPositions, type PreparedBrowserOrder } from "./polymarketOrder.js";
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
    positionSize: number;          // requested USDC
    actualSizeUsdc: number;        // actual USDC sent to CLOB (may differ due to rounding)
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

// Guards against concurrent resolution of the same trade when two bot cycles
// overlap (possible if a CLOB query takes longer than the 3s cycle interval).
const resolvingTradeIds = new Set<number>();

// Balance refresh: fetch on-chain wallet balance every N cycles and sync to DB
// Cycle is now 3s → 20 cycles ≈ 60 seconds
let _balanceRefreshCounter = 0;
const BALANCE_REFRESH_EVERY_N_CYCLES = 20; // every ~60 seconds at 3s/cycle

// Log throttle: suppress repeated NO_TRADE / TOO_EARLY logs
// Only print once per 15 seconds unless in the entry window
let _lastNoTradeLogAt = 0;
const NO_TRADE_LOG_THROTTLE_MS = 15_000;

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
    positionSize, actualSizeUsdc, shares: estimatedShares, priceImpact, btcPrice, marketId } = ctx;
  // Use the actual USDC deducted by the CLOB (may be larger than positionSize due to min-token rule)
  const deductedUsdc = actualSizeUsdc ?? positionSize;

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
          balance: state.balance - deductedUsdc,
          totalTrades: state.totalTrades + 1,
          lastSignal: `LIVE BUY ${direction} — $${deductedUsdc.toFixed(2)} placed`,
          lastUpdated: new Date(),
        }).where(eq(botStateTable.id, botId));
      }
      console.log(`[LIVE/BROWSER] BUY ${isMatched ? "MATCHED" : "LIVE(pending)"}: ${orderId} | shares=${shares.toFixed(2)} | balance deducted $${deductedUsdc.toFixed(4)}`);
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

const TEST_HOLD_MS = 30_000;  // 30 seconds minimum hold before closing a test position

// Take-profit: if the current Polymarket market price of our held tokens has
// risen ≥ this many cents above our entry price, sell and lock in the gain.
// This is a REAL executable trade (CLOB limit order at the market bid).
// 15¢ on ~2 shares ≈ +$0.30 per trade.  After exit we immediately re-enter
// the same direction if there's still edge and time remaining.
const TAKE_PROFIT_MARKET_GAIN = 0.15;

// Minimum time to hold a LIVE position before considering an early exit.
// 30s gives the trade a moment to breathe; natural resolution at window end is the primary exit.
const LIVE_MIN_HOLD_MS = 30_000; // 30 seconds

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
      minEdgeThreshold: 0.04,
      sizingMode: "kelly",
      flatSizeUsdc: 1.0,
      lossStreak: 0,
      sizingMultiplier: 1.0,
      dailyStartBalance: 20,
      weeklyStartBalance: 20,
      dailyStopTriggered: false,
      weeklyStopTriggered: false,
      drawdownPaused: false,
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

  const sizingMode = opts.sizingMode ?? "kelly"; // always Kelly by default
  const flatSizeUsdc = opts.flatSizeUsdc ?? 1.0;
  const now = new Date();

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
      kellyFraction: opts.kellyFraction ?? 0.25, // Quarter-Kelly
      minEdgeThreshold: opts.minEdgeThreshold ?? 0.04, // 4% default
      sizingMode,
      flatSizeUsdc,
      lastUpdated: now,
      // Reset drawdown protection
      lossStreak: 0,
      sizingMultiplier: 1.0,
      dailyStartBalance: initialBalance,
      weeklyStartBalance: initialBalance,
      dailyStopTriggered: false,
      weeklyStopTriggered: false,
      drawdownPaused: false,
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
      lossStreak: 0,
      sizingMultiplier: 1.0,
      dailyStartBalance: 20,
      weeklyStartBalance: 20,
      dailyStopTriggered: false,
      weeklyStopTriggered: false,
      drawdownPaused: false,
    })
    .where(eq(botStateTable.id, state.id));
  await db.delete(tradesTable);
  return getBotState();
}

function startPolling(botId: number) {
  stopPolling();
  // WebSocket feeds BTC price in real-time; cycle can be fast without rate-limit risk.
  // 3-second cycle gives 10+ data points in the critical 10–40s entry window.
  pollingInterval = setInterval(() => runBotCycle(botId), 3_000);
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
function decode5mMarketId(marketId: string): { windowEnd: number; conditionId: string; orderId?: string } | null {
  const parts = marketId.split(":");
  if (parts[0] !== "btc5m" || parts.length < 3) return null;
  // parts[2] is the conditionId (0x hex, never contains ':')
  // orderId, if stored, follows after '::' → parts[3]=="" and parts[4]=orderId
  const conditionId = parts[2];
  const orderId = parts.length >= 5 && parts[3] === "" ? parts[4] : undefined;
  return { windowEnd: parseInt(parts[1]), conditionId, orderId };
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

    // ── Drawdown check: abort the full cycle if trading is paused ──
    if (freshState.drawdownPaused) {
      const reason = freshState.weeklyStopTriggered ? "WEEKLY_STOP"
        : freshState.dailyStopTriggered ? "DAILY_STOP"
        : `LOSS_STREAK_${freshState.lossStreak}`;
      await db.update(botStateTable).set({
        lastSignal: `PAUSED — ${reason} (press Continue to resume)`,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
      return;
    }

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

    // ── Late-cycle sniping: ONLY enter in the final 10–40 second window ──
    // Entering too early gives the market time to move against us; entering
    // in the last 5s risks the order not filling before resolution.
    const LATE_ENTRY_MAX = 40; // don't enter when more than this many seconds remain
    const LATE_ENTRY_MIN = 5;  // don't enter when fewer than this many seconds remain
    const tooEarly = market5m.secondsRemaining > LATE_ENTRY_MAX;
    const tooLate  = market5m.secondsRemaining < LATE_ENTRY_MIN;

    let signal: "BUY_YES" | "BUY_NO" | "NO_TRADE" = "NO_TRADE";
    let positionSize = 0;
    let shares = 0;

    // Hard cap: skip if market is already too one-sided in either direction.
    // If UP=75¢ the outcome is nearly priced in — no edge to capture.
    const MAX_MARKET_CERTAINTY = 0.75;
    const priceTooCertain = Math.max(upPrice, downPrice) > MAX_MARKET_CERTAINTY;

    // Apply sizing multiplier from drawdown protection (0.5 after 5 loss streak)
    const sizingMultiplier = freshState.sizingMultiplier ?? 1.0;

    const minBalance = freshState.sizingMode === "flat" ? freshState.flatSizeUsdc : 0.5;
    if (!tooEarly && !tooLate && !priceTooCertain && edge >= freshState.minEdgeThreshold && freshState.balance >= minBalance) {
      signal = isBuyUp ? "BUY_YES" : "BUY_NO";

      if (freshState.sizingMode === "flat") {
        positionSize = Math.min(freshState.flatSizeUsdc * sizingMultiplier, freshState.balance);
        shares = entryPrice > 0 ? positionSize / entryPrice : 0;
      } else {
        const CLOB_MIN_ORDER = 1.0;
        const kellyFull = calcKelly(winProb, entryPrice);
        const kellyScaled = kellyFull * freshState.kellyFraction; // Quarter-Kelly by default
        const rawSize = freshState.balance * kellyScaled * sizingMultiplier;
        positionSize = Math.min(Math.max(rawSize, CLOB_MIN_ORDER), freshState.balance);
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
      const certainSide = upPrice > downPrice ? `UP=${(upPrice*100).toFixed(1)}¢` : `DOWN=${(downPrice*100).toFixed(1)}¢`;
      const reason = tooEarly ? `TOO_EARLY (${market5m.secondsRemaining}s left, wait for ≤${LATE_ENTRY_MAX}s)`
        : tooLate  ? `TOO_LATE (${market5m.secondsRemaining}s left, min ${LATE_ENTRY_MIN}s)`
        : priceTooCertain ? `PRICE_CAP (${certainSide} > ${MAX_MARKET_CERTAINTY*100}¢ max)`
        : `edge ${edgePct}% < threshold ${(freshState.minEdgeThreshold*100).toFixed(1)}%`;
      // Throttle: with 3s cycles, log at most once per 15s to reduce noise.
      // Always log if we're in (or near) the entry window.
      const inOrNearWindow = !tooEarly;
      if (inOrNearWindow || Date.now() - _lastNoTradeLogAt > NO_TRADE_LOG_THROTTLE_MS) {
        _lastNoTradeLogAt = Date.now();
        console.log(`[5M] NO_TRADE | UP=${upPct}¢ DOWN=${downPct}¢ model=${probUpPct}% btc1m=${chg1m} | ${reason} | ${secStr}`);
      }
    } else {
      const sizeTag = sizingMultiplier < 1 ? ` [×${sizingMultiplier} drawdown]` : "";
      const dir = isBuyUp ? "BUY_UP" : "BUY_DOWN";
      console.log(`[5M] ${dir} | UP=${upPct}¢ DOWN=${downPct}¢ model=${probUpPct}% btc1m=${chg1m} edge=+${edgePct}% size=$${positionSize.toFixed(2)}${sizeTag} | ${secStr}`);
    }

    await db
      .update(botStateTable)
      .set({ currentMarketPrice: upPrice, lastSignal: signal, lastUpdated: new Date() })
      .where(eq(botStateTable.id, botId));

    // ── Step 3a: Take-profit check (both modes; runs even in TOO_LATE / NO_TRADE) ──
    // Must happen before the NO_TRADE early-return so late-window price moves
    // are captured.  For LIVE, only fires when the position is in the current window
    // (prices from a resolved window no longer reflect token value).
    {
      const modeStr = freshState.mode.toUpperCase();
      const holdMinMs = freshState.mode === "test" ? TEST_HOLD_MS : LIVE_MIN_HOLD_MS;
      const openPositions = await db.select().from(tradesTable)
        .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, freshState.mode)));

      if (openPositions.length > 0) {
        const pos = openPositions[0];

        // LIVE: only apply TP when the position belongs to the current 5m window
        const posInfo = decode5mMarketId(pos.marketId ?? "");
        const inCurrentWindow = freshState.mode === "test" || (posInfo && posInfo.windowEnd === market5m.windowEnd);

        if (inCurrentWindow && !pendingSellTradeIds.has(pos.id)) {
          const heldMs = Date.now() - pos.timestamp.getTime();

          if (heldMs >= holdMinMs) {
            const weBoughtUp = pos.direction === "YES";
            const currentHeldPrice = weBoughtUp ? upPrice : 1 - upPrice;
            const entryHeldPrice   = weBoughtUp ? pos.marketPrice : 1 - pos.marketPrice;
            const marketGain = currentHeldPrice - entryHeldPrice;
            const dir = weBoughtUp ? "UP" : "DOWN";
            const gainCents = (marketGain * 100).toFixed(1);
            const tpCents   = (TAKE_PROFIT_MARKET_GAIN * 100).toFixed(0);
            const gainSign  = marketGain >= 0 ? "+" : "";
            console.log(
              `[5M ${modeStr}] Holding ${dir} | market ${(entryHeldPrice*100).toFixed(1)}¢ → ` +
              `${(currentHeldPrice*100).toFixed(1)}¢ (${gainSign}${gainCents}¢ of ${tpCents}¢ TP target)`
            );

            if (marketGain >= TAKE_PROFIT_MARKET_GAIN) {
              const estPnl = pos.shares * marketGain;
              console.log(
                `[5M ${modeStr}] Take-profit ${dir} | market +${(marketGain * 100).toFixed(1)}¢ ` +
                `(${(entryHeldPrice * 100).toFixed(1)}¢ → ${(currentHeldPrice * 100).toFixed(1)}¢) | ` +
                `est P&L +$${estPnl.toFixed(4)}`
              );
              if (freshState.mode === "test") {
                await closeTestPositionEarly(botId, pos, upPrice);
              } else {
                const preloadedTid = pos.direction === "YES" ? market5m.upTokenId : market5m.downTokenId;
                await closeLivePositionEarly(botId, pos, upPrice, market5m.conditionId, "TAKE_PROFIT", preloadedTid);
              }
              // Do NOT re-enter immediately — wait for price to pull back.
              return;
            }
          }
        }
      }
    }

    if (signal === "NO_TRADE" || positionSize < 1.0 || shares <= 0) return;

    const marketId = encode5mMarketId(market5m);
    const evPerShare = winProb * (1 - entryPrice) - (1 - winProb) * entryPrice;

    // ── Step 3b: Open new position, or flip if signal reversed ──
    if (freshState.mode === "test") {
      const openPositions = await db.select().from(tradesTable)
        .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "test")));

      if (openPositions.length > 0) {
        const pos = openPositions[0];
        const heldMs = Date.now() - pos.timestamp.getTime();
        const signalFlipped = pos.direction !== direction;

        if (signalFlipped && heldMs >= TEST_HOLD_MS) {
          // Signal reversed after minimum hold — exit at Polymarket market price
          // (simulates selling tokens at the real bid, which barely moves in these
          // illiquid markets, giving ~$0 P&L on exit) then open the other side.
          await closeTestPositionEarly(botId, pos, upPrice);
          const [updatedState] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
          if (!updatedState || updatedState.balance < 1.0) return;
          const newSize  = Math.min(positionSize, updatedState.balance);
          const newShares = entryPrice > 0 ? newSize / entryPrice : 0;
          await openTestPosition(botId, updatedState, {
            direction, marketPrice: upPrice, edge, evPerShare,
            kellyScaledPct: newSize / updatedState.balance, positionSize: newSize, shares: newShares, priceImpact: 0,
          }, btcData.currentPrice, marketId);
        } else if (signalFlipped) {
          console.log(`[5M TEST] Flip signal (${pos.direction}→${direction}) but held only ${Math.round(heldMs/1000)}s — waiting for ${TEST_HOLD_MS/1000}s min`);
        }
        return;
      }

      await openTestPosition(botId, freshState, {
        direction, marketPrice: upPrice, edge, evPerShare,
        kellyScaledPct: positionSize / freshState.balance, positionSize, shares, priceImpact: 0,
      }, btcData.currentPrice, marketId);
    } else {
      const openLivePositions = await db.select().from(tradesTable)
        .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "live")));
      if (openLivePositions.length > 0) {
        const pos = openLivePositions[0];
        // If SELL already queued (TP or flip), wait for relay to complete
        if (pendingSellTradeIds.has(pos.id)) {
          console.log("[LIVE] SELL already queued — waiting for relay");
          return;
        }
        const posInfo = decode5mMarketId(pos.marketId ?? "");
        const inCurrentWindow = posInfo && posInfo.windowEnd === market5m.windowEnd;
        const heldMs = Date.now() - pos.timestamp.getTime();
        const signalFlipped = pos.direction !== direction;

        if (inCurrentWindow && signalFlipped && heldMs >= LIVE_MIN_HOLD_MS) {
          // Signal reversed — exit current position and allow re-entry in same window
          console.log(`[LIVE] Flip signal (${pos.direction}→${direction}) after ${Math.round(heldMs/1000)}s — queuing SELL`);
          const preloadedTid = pos.direction === "YES" ? market5m.upTokenId : market5m.downTokenId;
          const flipped = await closeLivePositionEarly(botId, pos, upPrice, market5m.conditionId, "FLIP", preloadedTid);
          if (flipped) attemptedWindowEnds.delete(market5m.windowEnd); // allow re-entry this window
        } else if (inCurrentWindow && signalFlipped) {
          console.log(`[LIVE] Flip signal (${pos.direction}→${direction}) but held only ${Math.round(heldMs/1000)}s — waiting for ${LIVE_MIN_HOLD_MS/1000}s min`);
        }
        // else: holding same direction (log already shown in step 3a TP check)
        return;
      }
      const hasPendingBuy = browserOrderQueue.some(o => o.botId === botId && o.tradeContext.orderSide === "BUY");
      if (hasPendingBuy) {
        console.log("[LIVE] Skipping — BUY already queued, awaiting relay");
        return;
      }

      // Only attempt entry ONCE per 5-minute window (unless geoblocked — then retry is allowed)
      if (attemptedWindowEnds.has(market5m.windowEnd)) {
        console.log(`[LIVE] Already attempted window ${new Date(market5m.windowEnd * 1000).toISOString()} — waiting for next window`);
        return;
      }

      const tokenId = direction === "YES" ? market5m.upTokenId : market5m.downTokenId;
      const tradeResult = await executeLiveTrade(botId, freshState, {
        direction, marketPrice: upPrice, edge, evPerShare,
        kellyScaledPct: positionSize / freshState.balance, positionSize, shares, priceImpact: 0,
      }, btcData.currentPrice, marketId, market5m.conditionId, tokenId);

      // Mark window attempted only when order was placed or failed for a non-geoblock reason.
      // On geoblock, leave the window open so the browser relay can still submit it,
      // and a retry can happen if the proxy reconnects mid-window.
      if (!tradeResult?.geoblocked) {
        attemptedWindowEnds.add(market5m.windowEnd);
        // Prune old window entries (keep only last 5)
        if (attemptedWindowEnds.size > 5) {
          const sorted = [...attemptedWindowEnds].sort((a, b) => a - b);
          for (let i = 0; i < sorted.length - 5; i++) attemptedWindowEnds.delete(sorted[i]);
        }
      } else {
        console.log("[LIVE] Geoblock on this attempt — window left open for browser relay / retry.");
      }
    }
  } catch (err) {
    console.error("Bot cycle error:", err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// DRAWDOWN PROTECTION
// Runs after every resolved position. Updates loss streak, sizing multiplier,
// daily/weekly drawdown checks. Pauses trading when limits are hit.
// ──────────────────────────────────────────────────────────────────────────────

const DAILY_STOP_PCT   = 0.40; // stop at -40% of daily start balance
const WEEKLY_STOP_PCT  = 0.60; // stop at -60% of weekly start balance
const LOSS_STREAK_HALF = 5;    // halve sizing after this many consecutive losses
const LOSS_STREAK_STOP = 7;    // pause trading after this many consecutive losses

async function updateDrawdownProtection(
  botId: number,
  weWon: boolean,
  newBalance: number,
): Promise<void> {
  const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
  if (!st) return;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekStr  = `${now.getFullYear()}-W${Math.ceil(now.getDate() / 7)}`;

  // Reset daily anchor at start of new UTC day
  const lastUpdatedDay = st.lastUpdated?.toISOString().slice(0, 10);
  const isNewDay = lastUpdatedDay !== todayStr;

  // Reset weekly anchor at start of new week (Monday)
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon
  const isNewWeek = dayOfWeek === 1 && lastUpdatedDay !== todayStr; // rough weekly reset

  const dailyStart  = (isNewDay  ? newBalance : (st.dailyStartBalance  ?? newBalance));
  const weeklyStart = (isNewWeek ? newBalance : (st.weeklyStartBalance ?? newBalance));

  // Loss streak
  const newStreak = weWon ? 0 : (st.lossStreak ?? 0) + 1;
  if (!weWon) {
    if (newStreak === LOSS_STREAK_HALF) {
      console.warn(`[DRAWDOWN] ${newStreak} consecutive losses — halving position size`);
    }
    if (newStreak >= LOSS_STREAK_STOP) {
      console.warn(`[DRAWDOWN] ${newStreak} consecutive losses — PAUSING trading. Press "Continue" to resume.`);
    }
  }

  // Sizing multiplier: 1.0 normally, 0.5 after LOSS_STREAK_HALF losses
  const sizingMultiplier = newStreak >= LOSS_STREAK_HALF ? 0.5 : 1.0;

  // Drawdown stops
  const dailyDrawdown   = dailyStart > 0 ? (dailyStart - newBalance) / dailyStart : 0;
  const weeklyDrawdown  = weeklyStart > 0 ? (weeklyStart - newBalance) / weeklyStart : 0;

  const dailyTriggered  = dailyDrawdown  >= DAILY_STOP_PCT;
  const weeklyTriggered = weeklyDrawdown >= WEEKLY_STOP_PCT;
  const paused = newStreak >= LOSS_STREAK_STOP || dailyTriggered || weeklyTriggered;

  if (dailyTriggered && !st.dailyStopTriggered) {
    console.warn(`[DRAWDOWN] Daily stop hit (-${(dailyDrawdown*100).toFixed(1)}%) — PAUSING. Press "Continue" to override.`);
  }
  if (weeklyTriggered && !st.weeklyStopTriggered) {
    console.warn(`[DRAWDOWN] Weekly stop hit (-${(weeklyDrawdown*100).toFixed(1)}%) — PAUSING. Press "Continue" to override.`);
  }

  await db.update(botStateTable).set({
    lossStreak: newStreak,
    sizingMultiplier,
    dailyStartBalance:  dailyStart,
    weeklyStartBalance: weeklyStart,
    dailyStopTriggered:  dailyTriggered  || st.dailyStopTriggered,
    weeklyStopTriggered: weeklyTriggered || st.weeklyStopTriggered,
    drawdownPaused: paused,
    lastUpdated: now,
  }).where(eq(botStateTable.id, botId));

  void weekStr; // suppress unused warning
}

/** Reset all drawdown stops and loss streaks so trading can continue. */
export async function resetDrawdownStops(botId: number): Promise<void> {
  const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
  if (!st) return;
  await db.update(botStateTable).set({
    lossStreak: 0,
    sizingMultiplier: 1.0,
    dailyStopTriggered: false,
    weeklyStopTriggered: false,
    drawdownPaused: false,
    dailyStartBalance: st.balance,
    weeklyStartBalance: st.balance,
    lastUpdated: new Date(),
  }).where(eq(botStateTable.id, botId));
  console.log(`[DRAWDOWN] Stops reset — trading resumed from $${st.balance.toFixed(2)}`);
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

    // Guard: skip if another concurrent cycle is already resolving this trade
    if (resolvingTradeIds.has(pos.id)) continue;
    resolvingTradeIds.add(pos.id);

    const secsSinceClose = nowSec - info.windowEnd;

    // ── Use Polymarket CLOB oracle as the primary winner source ──────────────
    // This is the same data Polymarket uses to resolve and pay out — accurate
    // regardless of where BTC moved after the window closed.
    // Fall back to BTC price comparison only if the CLOB is unreachable.
    let upWon: boolean | null = null;
    let resolvedVia = "btc_price_fallback";

    try {
      const clobRes = await fetch(`https://clob.polymarket.com/markets/${info.conditionId}`, {
        signal: AbortSignal.timeout(6000),
      });

      if (clobRes.ok) {
        const clobData = await clobRes.json() as {
          closed: boolean;
          tokens: Array<{ token_id: string; outcome: string; price: number; winner: boolean }>;
        };

        const upToken  = clobData.tokens?.find(t => t.outcome.toLowerCase() === "up");
        const downToken = clobData.tokens?.find(t => t.outcome.toLowerCase() === "down");
        const upPrice   = upToken?.price ?? 0.5;
        const downPrice = downToken?.price ?? 0.5;

        // Official winner flag (set by Polymarket oracle — may lag 2-5 min)
        if (upToken?.winner === true) {
          upWon = true; resolvedVia = "clob_oracle";
        } else if (downToken?.winner === true) {
          upWon = false; resolvedVia = "clob_oracle";
        } else if (secsSinceClose >= 30 && (upPrice >= 0.85 || downPrice >= 0.85)) {
          // Price fallback: market makers reprice winning side to ~$1 before oracle fires
          upWon = upPrice >= 0.85;
          resolvedVia = `clob_price (UP=${(upPrice*100).toFixed(1)}¢, ${secsSinceClose}s since close)`;
        } else {
          // Oracle not yet fired, price not yet decisive — check again next cycle
          console.log(`[5M TEST] Awaiting resolution (UP=${(upPrice*100).toFixed(1)}¢ DOWN=${(downPrice*100).toFixed(1)}¢, ${secsSinceClose}s since close)`);
          resolvingTradeIds.delete(pos.id); // release so next cycle retries
          continue;
        }
      }
    } catch {
      // CLOB unreachable — fall back to BTC price at current vs entry
    }

    // BTC price fallback: use current live price vs price at time of entry
    if (upWon === null) {
      const entryBtc = pos.btcPriceAtEntry ?? currentBtcPrice;
      upWon = currentBtcPrice >= entryBtc;
      resolvedVia = `btc_price (entry=${entryBtc.toFixed(0)} now=${currentBtcPrice.toFixed(0)})`;
    }

    // Did we pick the winner?
    const weBoughtUp = pos.direction === "YES";
    const weWon = weBoughtUp ? upWon : !upWon;

    const entryPrice = weBoughtUp ? pos.marketPrice : 1 - pos.marketPrice;
    const exitValue = weWon ? 1.0 : 0.0;
    const pnl = pos.shares * (exitValue - entryPrice);
    const returnedCapital = pos.positionSize + pnl;

    const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (!st) { resolvingTradeIds.delete(pos.id); continue; }

    await db.update(tradesTable).set({
      status: "closed", exitPrice: exitValue, pnl, resolvedAt: new Date(),
    }).where(eq(tradesTable.id, pos.id));

    const newBalance = st.balance + returnedCapital;
    await db.update(botStateTable).set({
      balance: newBalance,
      totalTrades: st.totalTrades + 1,
      winningTrades: weWon ? st.winningTrades + 1 : st.winningTrades,
      losingTrades: weWon ? st.losingTrades : st.losingTrades + 1,
      totalPnl: st.totalPnl + pnl,
      lastUpdated: new Date(),
    }).where(eq(botStateTable.id, botId));

    resolvingTradeIds.delete(pos.id);

    const direction = weBoughtUp ? "UP" : "DOWN";
    const winner = upWon ? "UP" : "DOWN";
    const result = weWon ? "WON" : "LOST";
    console.log(
      `[5M TEST] ${result} ${direction} | winner=${winner} via ${resolvedVia} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} | balance: $${newBalance.toFixed(2)}`
    );

    await updateDrawdownProtection(botId, weWon, newBalance);
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
    if (resolvingTradeIds.has(pos.id)) continue; // concurrent cycle guard

    const info = decode5mMarketId(pos.marketId ?? "");
    if (!info) continue;

    if (nowSec < info.windowEnd) continue; // window not done yet

    resolvingTradeIds.add(pos.id);
    console.log(`[LIVE 5M] Checking resolution for trade #${pos.id} | conditionId=${info.conditionId}`);

    // Query CLOB to see who won — use direct fetch (market data is not geoblocked)
    try {
      const clobRes = await fetch(`https://clob.polymarket.com/markets/${info.conditionId}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!clobRes.ok) {
        console.warn(`[LIVE 5M] CLOB fetch failed (${clobRes.status}) for ${info.conditionId}`);
        continue;
      }

      const clobData = await clobRes.json() as {
        closed: boolean;
        tokens: Array<{ token_id: string; outcome: string; price: number; winner: boolean }>;
      };

      const upToken = clobData.tokens?.find(t => t.outcome.toLowerCase() === "up");
      const downToken = clobData.tokens?.find(t => t.outcome.toLowerCase() === "down");

      const upPrice = upToken?.price ?? 0.5;
      const downPrice = downToken?.price ?? 0.5;

      // Primary: official winner flag. Fallback: price ≥ 0.85 after window closed ≥ 30s
      // (Polymarket's oracle can lag 2-5 min; prices already reflect the winner by then)
      const secsSinceClose = nowSec - info.windowEnd;
      const priceResolutionOk = secsSinceClose >= 30;
      const upWon  = upToken?.winner  === true || (priceResolutionOk && upPrice  >= 0.85);
      const downWon = downToken?.winner === true || (priceResolutionOk && downPrice >= 0.85);

      if (!upWon && !downWon) {
        console.log(`[LIVE 5M] Market not yet resolved (closed=${clobData.closed}, UP=${(upPrice*100).toFixed(1)}¢, DOWN=${(downPrice*100).toFixed(1)}¢, ${secsSinceClose}s since close) — waiting`);
        continue;
      }

      const resolvedViaPrice = !upToken?.winner && !downToken?.winner;
      if (resolvedViaPrice) {
        console.log(`[LIVE 5M] Resolving via price fallback (UP=${(upPrice*100).toFixed(1)}¢ DOWN=${(downPrice*100).toFixed(1)}¢, ${secsSinceClose}s since close)`);
      }

      const weBoughtUp = pos.direction === "YES";
      const weWon = weBoughtUp ? upWon : downWon;

      const entryPrice = weBoughtUp ? pos.marketPrice : 1 - pos.marketPrice;
      const exitValue = weWon ? 1.0 : 0.0;

      // If shares=0 (order was resting in book when confirmed), estimate from cost/price
      const effectiveShares = pos.shares > 0 ? pos.shares : pos.positionSize / entryPrice;
      const effectiveCost = pos.shares > 0 ? pos.positionSize : effectiveShares * entryPrice;
      const pnl = effectiveShares * exitValue - effectiveCost; // profit from tokens - cost paid
      const returnedCapital = effectiveCost + pnl; // = effectiveShares * exitValue

      const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
      if (!st) continue;

      await db.update(tradesTable).set({
        status: "closed", exitPrice: exitValue, pnl, resolvedAt: new Date(),
      }).where(eq(tradesTable.id, pos.id));

      const creditedBalance = st.balance + returnedCapital;
      await db.update(botStateTable).set({
        balance: creditedBalance,
        totalTrades: st.totalTrades + 1, // fix: was missing from LIVE resolution
        winningTrades: weWon ? st.winningTrades + 1 : st.winningTrades,
        losingTrades: weWon ? st.losingTrades : st.losingTrades + 1,
        totalPnl: st.totalPnl + pnl,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));

      const direction = weBoughtUp ? "UP" : "DOWN";
      const result = weWon ? "WON" : "LOST";
      console.log(`[LIVE 5M] ${result} ${direction} | shares=${effectiveShares.toFixed(2)} P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} | balance: $${creditedBalance.toFixed(2)}`);

      await updateDrawdownProtection(botId, weWon, creditedBalance);

      // If we won, attempt on-chain CTF redemption immediately so USDC returns
      if (weWon) {
        console.log(`[LIVE 5M] Claiming winnings on-chain for ${info.conditionId.substring(0, 10)}...`);
        // Fire-and-forget: don't block resolution of other positions
        redeemWinningPositions(info.conditionId).then((ok) => {
          if (ok) {
            // Redemption succeeded — sync the updated on-chain balance
            getWalletBalance().then((b) => {
              if (b !== null && b > 0) {
                db.update(botStateTable).set({ balance: Math.max(b, creditedBalance), lastUpdated: new Date() })
                  .where(eq(botStateTable.id, botId))
                  .then(() => console.log(`[LIVE 5M] Post-redeem wallet: $${b.toFixed(2)}`))
                  .catch(() => {});
              }
            }).catch(() => {});
          }
        }).catch(() => {});
      }

      // Sync on-chain balance — but NEVER let it lower the DB balance below our
      // computed credit (prevents redemption-pending state from looking like a loss).
      const walletBal = await getWalletBalance();
      if (walletBal !== null && walletBal >= 0) {
        const effectiveBal = Math.max(walletBal, creditedBalance);
        await db.update(botStateTable).set({ balance: effectiveBal, lastUpdated: new Date() })
          .where(eq(botStateTable.id, botId));
        if (walletBal < creditedBalance) {
          console.log(`[LIVE 5M] Redemption pending — using credited $${creditedBalance.toFixed(2)} (on-chain: $${walletBal.toFixed(2)})`);
        } else {
          console.log(`[LIVE 5M] Wallet synced: $${walletBal.toFixed(2)}`);
        }
      }
    } catch (err) {
      console.error(`[LIVE 5M] resolve error for trade #${pos.id}:`, err);
    } finally {
      resolvingTradeIds.delete(pos.id);
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
// TEST MODE — Intra-window exit (signal flip only, before window-end resolution)
//
// Simulates selling tokens back at the current Polymarket market price — the
// same price you'd actually get trying to exit an illiquid 5-min binary market.
// Because these markets are illiquid the exit price is very close to entry,
// so P&L here is typically near $0.  The real P&L comes from window-end
// binary resolution (×1 if won, ×0 if lost), handled by resolve5mTestPositions.
// ──────────────────────────────────────────────────────────────────────────────

async function closeTestPositionEarly(
  botId: number,
  pos: { id: number; direction: "YES" | "NO"; marketPrice: number; shares: number; positionSize: number },
  currentUpPrice: number,   // real Polymarket UP token price right now
) {
  const weBoughtUp = pos.direction === "YES";
  // Exit at current Polymarket market price — what you'd actually get selling
  const exitPrice = weBoughtUp ? currentUpPrice : 1 - currentUpPrice;
  const entryPrice = weBoughtUp ? pos.marketPrice : 1 - pos.marketPrice;
  const pnl = pos.shares * (exitPrice - entryPrice);
  const returnedCapital = pos.positionSize + pnl;

  const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
  if (!st) return;

  await db.update(tradesTable).set({
    status: "closed", exitPrice, pnl, resolvedAt: new Date(),
  }).where(eq(tradesTable.id, pos.id));

  await db.update(botStateTable).set({
    balance: st.balance + returnedCapital,
    totalTrades: st.totalTrades + 1,
    winningTrades: pnl >= 0 ? st.winningTrades + 1 : st.winningTrades,
    losingTrades:  pnl <  0 ? st.losingTrades  + 1 : st.losingTrades,
    totalPnl: st.totalPnl + pnl,
    lastUpdated: new Date(),
  }).where(eq(botStateTable.id, botId));

  const dir = weBoughtUp ? "UP" : "DOWN";
  console.log(`[5M TEST] Flip exit ${dir} @ market ${(exitPrice * 100).toFixed(1)}¢ | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);
}

// Force-closes any open TEST positions when the bot is stopped or reset.
// Uses the CLOB oracle (same as normal resolution) rather than BTC price
// comparison, so the results are consistent with how the bot normally settles.
async function forceCloseOpenTestPositions(botId: number) {
  const openPositions = await db
    .select().from(tradesTable)
    .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "test")));

  for (const pos of openPositions) {
    if (resolvingTradeIds.has(pos.id)) continue;
    resolvingTradeIds.add(pos.id);
    try {
      const info = decode5mMarketId(pos.marketId ?? "");
      let upWon: boolean | null = null;

      // Try CLOB oracle first (same as normal resolution path)
      if (info?.conditionId) {
        try {
          const clobRes = await fetch(`https://clob.polymarket.com/markets/${info.conditionId}`, {
            signal: AbortSignal.timeout(6000),
          });
          if (clobRes.ok) {
            const clobData = await clobRes.json() as {
              tokens: Array<{ outcome: string; price: number; winner: boolean }>;
            };
            const upToken   = clobData.tokens?.find(t => t.outcome.toLowerCase() === "up");
            const downToken = clobData.tokens?.find(t => t.outcome.toLowerCase() === "down");
            if (upToken?.winner === true)        { upWon = true; }
            else if (downToken?.winner === true) { upWon = false; }
            else if ((upToken?.price ?? 0) >= 0.85)   { upWon = true; }
            else if ((downToken?.price ?? 0) >= 0.85) { upWon = false; }
          }
        } catch {
          // fall through to BTC price fallback
        }
      }

      // BTC price fallback
      if (upWon === null) {
        const btcData = await getBtcPriceData().catch(() => null);
        const currentBtcPrice = btcData?.currentPrice ?? 0;
        const entryBtc = pos.btcPriceAtEntry ?? currentBtcPrice;
        upWon = currentBtcPrice >= entryBtc;
      }

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
      console.log(`[TEST] Force-closed #${pos.id} ${pos.direction} | ${weWon ? "WON" : "LOST"} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);
    } catch (err) {
      console.error(`[TEST] forceClose error for trade #${pos.id}:`, err);
    } finally {
      resolvingTradeIds.delete(pos.id);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// LIVE MODE — Early exit (take-profit or signal flip) via browser relay SELL
// ──────────────────────────────────────────────────────────────────────────────

async function closeLivePositionEarly(
  botId: number,
  pos: typeof tradesTable.$inferSelect,
  currentYesPrice: number,
  conditionId: string | null,
  reason: "TAKE_PROFIT" | "FLIP",
  preloadedTokenId?: string,
): Promise<boolean> {
  if (!conditionId) {
    console.warn("[LIVE] Cannot close early — no conditionId");
    return false;
  }
  if (pendingSellTradeIds.has(pos.id)) return false;

  const sellPrice  = pos.direction === "YES" ? currentYesPrice : 1 - currentYesPrice;
  const entryPrice = pos.direction === "YES" ? pos.marketPrice  : 1 - pos.marketPrice;

  const tokenId = preloadedTokenId ?? await getClobTokenId(conditionId, pos.direction);
  if (!tokenId) {
    console.error(`[LIVE] Cannot get tokenId for early ${reason} exit`);
    return false;
  }

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
        actualSizeUsdc: 0,
        shares: pos.shares,
        priceImpact: 0,
        btcPrice: 0,
        marketId: pos.marketId,
      },
      queuedAt: Date.now(),
    });

    const dir = pos.direction === "YES" ? "UP" : "DOWN";
    const gainCents = ((sellPrice - entryPrice) * 100).toFixed(1);
    const sign = sellPrice >= entryPrice ? "+" : "";
    console.log(
      `[LIVE] Early exit ${reason} ${dir} | ${(entryPrice*100).toFixed(1)}¢ → ${(sellPrice*100).toFixed(1)}¢ (${sign}${gainCents}¢) | ` +
      `queued SELL ${pos.shares.toFixed(2)} tokens`
    );
    await db.update(botStateTable).set({
      lastSignal: `LIVE SELL ${dir} — ${reason} @ ${(sellPrice * 100).toFixed(1)}¢`,
      lastUpdated: new Date(),
    }).where(eq(botStateTable.id, botId));

    return true;
  } catch (err) {
    console.error(`[LIVE] Failed to prepare early exit SELL:`, err);
    return false;
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
): Promise<{ geoblocked: boolean }> {
  const { direction, marketPrice, edge, kellyScaledPct, positionSize, shares, priceImpact } = trade;

  // ── Slippage protection: re-fetch live price before placing ──
  // If the price has moved > 1¢ against us since signal was computed, skip this trade.
  // This guards against entering on stale signals in a fast-moving market.
  if (conditionId) {
    try {
      const priceRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (priceRes.ok) {
        const priceData = await priceRes.json() as {
          tokens?: Array<{ outcome: string; price: number }>;
        };
        const upToken    = priceData.tokens?.find(t => t.outcome.toLowerCase() === "up");
        const downToken  = priceData.tokens?.find(t => t.outcome.toLowerCase() === "down");
        const liveUpPrice = upToken?.price ?? marketPrice;
        const liveDownPrice = downToken?.price ?? (1 - marketPrice);
        const liveIntended = direction === "YES" ? liveUpPrice : liveDownPrice;
        const intended     = direction === "YES" ? marketPrice  : 1 - marketPrice;
        const slippage = liveIntended - intended; // positive = moved against us (price went up)
        if (slippage > 0.01) {
          console.warn(`[LIVE] Slippage protection: price moved ${(slippage * 100).toFixed(1)}¢ against us (intended ${(intended*100).toFixed(1)}¢ → live ${(liveIntended*100).toFixed(1)}¢) — skipping`);
          return { geoblocked: false };
        }
        if (Math.abs(slippage) > 0.005) {
          console.log(`[LIVE] Slight slippage: ${(slippage * 100).toFixed(1)}¢ (within tolerance)`);
        }
      }
    } catch {
      // Non-fatal: if price re-fetch fails, proceed with original signal price
      console.warn("[LIVE] Slippage pre-check failed — proceeding with signal price");
    }
  }

  // limitPrice must be computed first — needed for 5-token minimum calculation
  const limitPrice = direction === "YES" ? marketPrice : 1 - marketPrice;
  // Polymarket CLOB minimum: 5 tokens per order. Enforce by bumping USDC accordingly.
  const minForFiveTokens = Math.ceil(5 * limitPrice * 100) / 100;
  const orderSize = Math.max(positionSize, MIN_LIVE_ORDER_USDC, minForFiveTokens);

  if (orderSize > state.balance) {
    console.log(`[LIVE] Skipping — order size $${orderSize.toFixed(2)} > balance $${state.balance.toFixed(2)}`);
    return { geoblocked: false };
  }

  let tokenId: string | null = preloadedTokenId ?? null;
  if (!tokenId && conditionId) tokenId = await getClobTokenId(conditionId, direction);

  if (!tokenId) {
    console.error(`[LIVE] Could not get CLOB token ID for ${direction} on ${conditionId}`);
    return { geoblocked: false };
  }

  const trueYesProb = Math.min(0.95, Math.max(0.05, marketPrice + edge));

  // Helper: build tradeContext using the actual USDC from a prepared order
  const makeTradeCtx = (actualSizeUsdc: number) => ({
    orderSide: "BUY" as const,
    direction, marketPrice, estimatedProb: trueYesProb, edge,
    kellyScaledPct, positionSize: orderSize, actualSizeUsdc, shares, priceImpact, btcPrice, marketId,
  });

  // ── Browser-relay mode: no proxy configured → queue for browser to submit ──
  if (!hasProxy()) {
    console.log(`[LIVE] No proxy — queuing ${direction} order for browser relay`);
    try {
      const prepared = await prepareOrderForBrowser({ tokenId, side: "BUY", price: limitPrice, sizeUsdc: orderSize });
      browserOrderQueue.push({ prepared, botId, tradeContext: makeTradeCtx(prepared.meta.actualSizeUsdc), queuedAt: Date.now() });
      await db.update(botStateTable).set({
        lastSignal: `LIVE ${direction} — awaiting browser relay ($${prepared.meta.actualSizeUsdc.toFixed(2)})`,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
    } catch (err) {
      console.error("[LIVE] Failed to prepare browser order:", err);
      await db.update(botStateTable).set({
        lastSignal: `ORDER PREP FAILED: ${String(err).substring(0, 60)}`,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
    }
    return { geoblocked: false };
  }

  // ── Proxy mode: place directly from server ──
  console.log(`[LIVE] Placing ${direction === "YES" ? "YES (UP)" : "NO (DOWN)"} order via proxy: $${orderSize.toFixed(2)} @ ${(limitPrice * 100).toFixed(1)}¢`);
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
    return { geoblocked: false };
  } else {
    const errorMsg = result.errorMessage ?? "";
    console.error(`[LIVE ORDER] Failed: ${errorMsg}`);
    const isGeoblock = errorMsg.includes("restricted") || errorMsg.includes("geoblock") || errorMsg.includes("region");
    if (isGeoblock) {
      console.warn("[LIVE] Proxy geoblocked — suspending for 5 min (will auto-retry when VPN region changes).");
      markProxyGeoblocked(); // 5-min cooldown; proxy URL preserved for auto-retry
      // Queue the same order via browser relay so the browser (on user's VPN) can submit it
      try {
        const prepared = await prepareOrderForBrowser({ tokenId, side: "BUY", price: limitPrice, sizeUsdc: orderSize });
        browserOrderQueue.push({ prepared, botId, tradeContext: makeTradeCtx(prepared.meta.actualSizeUsdc), queuedAt: Date.now() });
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
      return { geoblocked: true }; // ← caller should NOT mark window as attempted
    } else {
      await db.update(botStateTable).set({
        lastSignal: `ORDER FAILED: ${errorMsg.substring(0, 60)}`,
        lastUpdated: new Date(),
      }).where(eq(botStateTable.id, botId));
      return { geoblocked: false };
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
