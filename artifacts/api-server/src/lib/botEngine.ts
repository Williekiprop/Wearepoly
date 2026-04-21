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
import { eq, and, sql } from "drizzle-orm";
import { calcKelly, simulatePriceImpact } from "./lmsr.js";
import { getBtcPriceData, estimate5mUpProb, startBtcWebSocket } from "./btcPrice.js";
import { startOrderFlow, getOrderFlowData, updateWindowOpen } from "./orderFlow.js";
import { fetchCurrent5mMarket, getConnectionStatus, type FiveMinMarket } from "./polymarketClient.js";
import { placeOrder, prepareOrderForBrowser, getClobTokenId, getWalletBalance, redeemWinningPositions, getOrderFillStatus, type PreparedBrowserOrder } from "./polymarketOrder.js";
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

// Track BUY orders that have been dequeued by the browser relay but whose
// completeBrowserOrder() confirmation hasn't arrived yet. This prevents the
// race-window where the queue is empty (order popped) but the DB insert hasn't
// happened yet, causing a second BUY to be queued for the same window.
// Key: botId, Value: windowEnd timestamp of the in-flight BUY
const inFlightBuyWindows = new Map<number, number>();

// ── LATE-mode price drift ring buffer ────────────────────────────────────────
// Stores the last ~N upPrice samples per window so we can detect whether the
// market is running against our signal before we enter.  Keyed by windowEnd.
// Each entry is {ts: epochMs, upPrice: 0-1}.  Older than 30s are pruned each cycle.
const latePriceHistory = new Map<number, { ts: number; upPrice: number }[]>();

function recordLatePriceSample(windowEnd: number, upPrice: number) {
  const buf = latePriceHistory.get(windowEnd) ?? [];
  buf.push({ ts: Date.now(), upPrice });
  // Keep at most the last 20 samples (~60s at 3s poll rate)
  if (buf.length > 20) buf.shift();
  latePriceHistory.set(windowEnd, buf);
}

/** Returns the upPrice LATE_PRICE_DRIFT_WINDOW_MS ago, or null if no sample that old. */
function priceBeforeDriftWindow(windowEnd: number): number | null {
  const buf = latePriceHistory.get(windowEnd);
  if (!buf || buf.length < 2) return null;
  const cutoff = Date.now() - LATE_PRICE_DRIFT_WINDOW_MS;
  // Find the oldest sample that is still within 2× the drift window (don't go too far back)
  const oldSample = buf.find(s => s.ts <= cutoff);
  return oldSample?.upPrice ?? null;
}

// ── In-memory state cache ─────────────────────────────────────────────────────
// The status endpoint is polled every 3 seconds. Hitting PostgreSQL over the
// network for every poll adds 50-200ms on Render. Cache the state in memory
// and only re-query the DB when the cache is stale or a write invalidates it.
type BotStateRow = typeof botStateTable.$inferSelect;
let _stateCache: BotStateRow | null = null;
let _stateCacheTs = 0;
const STATE_CACHE_TTL = 2000; // ms — cache reads for 2 seconds

function _updateStateCache(s: BotStateRow) {
  _stateCache = s;
  _stateCacheTs = Date.now();
}
function _invalidateStateCache() {
  _stateCacheTs = 0;
}
// ─────────────────────────────────────────────────────────────────────────────

/** Called by the API route: browser polls for the next pending order. */
export function dequeueBrowserOrder(): PendingBrowserOrder | null {
  // Expire orders older than 50s (HMAC timestamp window)
  const now = Date.now();
  while (browserOrderQueue.length > 0 && now - browserOrderQueue[0].queuedAt > 50_000) {
    browserOrderQueue.shift();
  }
  const order = browserOrderQueue.shift() ?? null;
  if (order && order.tradeContext.orderSide === "BUY") {
    // Record this window as in-flight: the order is being processed by the browser
    // but hasn't been confirmed yet. Clear any stale in-flight entry first.
    const windowEnd = parseInt((order.tradeContext.marketId ?? "").split(":")[1] ?? "0");
    if (windowEnd > 0) {
      inFlightBuyWindows.set(order.botId, windowEnd);
      // Auto-expire after 60s in case completeBrowserOrder is never called (e.g. crash)
      setTimeout(() => {
        if (inFlightBuyWindows.get(order.botId) === windowEnd) {
          inFlightBuyWindows.delete(order.botId);
        }
      }, 60_000);
    }
  }
  return order;
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

  // Clear the in-flight tracker — this order is now confirmed (success or failure)
  if (orderSide === "BUY") {
    inFlightBuyWindows.delete(botId);
  }

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
          // NOTE: do NOT increment totalTrades here — the trade is open, not resolved yet.
          // totalTrades/winningTrades/losingTrades are counted at resolution time only,
          // so each trade is counted exactly once (when we know the win/loss outcome).
          dailyTradeCount: (state.dailyTradeCount ?? 0) + 1,
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

// ── Timing constants — LATE sniper mode (original behaviour) ─────────────────
// Enter only in the final 5–50s; hold to binary resolution; TP at 15¢.
const TEST_HOLD_MS        = 30_000;   // 30 s min hold before flip/TP in TEST mode
const LIVE_MIN_HOLD_MS    = 10_000;   // 10 s min hold before TP in LIVE mode (was 30s — too slow near expiry)
const TAKE_PROFIT_MARKET_GAIN = 0.15; // 15¢ price move = take-profit (late snipe)

// ── Timing constants — EDGE sniper mode (mid-window sniping) ─────────────────
// Enter after the 1st minute (≤240 s remain), exit early on TP or signal flip.
// Multiple entries per window are allowed — re-enter after each exit.
const EDGE_HOLD_MS        = 10_000;   // 10 s min hold before flip/TP in EDGE mode
const EDGE_TAKE_PROFIT    = 0.08;     // 8¢ price move = take-profit (edge snipe)
const EDGE_STOP_LOSS      = 0.08;     // 8¢ adverse move = stop-loss (matches TP → 1:1 risk-reward, profitable at >50% win rate)
// Edge sweet-spot cap: trades with computed edge >22% are paradoxically bad.
// When the model sees >22% edge, the price is so extreme that the market has
// already priced in strong momentum the 1-minute BTC signal can't see.
// Data: YES (BUY_UP): edge 22%+ → 14–50% win rate — cap at 22%.
//       NO  (BUY_DOWN): 71–72¢ UP range → 75–83% win rate, edge 22–27% — cap at 30%.
// Direction-aware: YES cap tighter because high-edge YES = market is right; we're wrong.
// High-edge NO = market overshot UP; contrarian is correct.
const MAX_EDGE_THRESHOLD_YES = 0.22;
const MAX_EDGE_THRESHOLD_NO  = 0.30;
// Slippage estimate: real CLOB fills at the ASK (buying) or BID (selling).
// Midpoint is used for signal decisions, but we deduct ~1¢ from P&L on entry
// to give an honest simulation of real fill costs.
const ENTRY_SLIPPAGE      = 0.01;     // 1¢ per entry (half-spread estimate)

// Entry windows per mode
const LATE_ENTRY_MAX = 50;   // enter only when ≤ 50 s remain (tightened from 90s — at 60-90s the market already priced in-window momentum)
const LATE_ENTRY_MIN = 5;    // but not in the final 5 s (order may not fill)
const EDGE_ENTRY_MAX = 240;  // enter up to 4 min from end (≥ 1 min elapsed in 5-min window)
const EDGE_ENTRY_MIN = 51;   // don't overlap with the late-snipe zone (matches LATE_ENTRY_MAX+1)

// Risk management constants
const MAX_POSITION_PCT  = 0.25; // hard cap: never risk more than 25% of balance on a single trade
const MAX_DAILY_TRADES  = 1000;  // safety valve: pause new entries if ≥ 100 trades placed today

// LATE mode stop-loss: exit if market moves ≥ 10¢ against us.
// Prevents holding to a full binary loss (100% drawdown) when the market has clearly rejected the signal.
// At typical 30-50¢ entry prices, 10¢ adverse move caps loss at ~25-35% of position cost.
const LATE_STOP_LOSS = 0.10;

// Smart exit threshold (LATE mode only)
// If the model's estimated win probability for our position drops below this level
// we treat the trade as reversed and exit early rather than hold to binary resolution.
const LATE_SMART_EXIT_PROB = 0.35;  // exit if model win prob falls below 35%

// Price-drift guard: if the CLOB has moved ≥ this many cents against our intended direction
// in the last LATE_PRICE_DRIFT_WINDOW_MS milliseconds, skip entry (market knows something we don't).
const LATE_PRICE_DRIFT_GUARD = 0.04; // 4¢ drift = skip entry
const LATE_PRICE_DRIFT_WINDOW_MS = 15_000; // look back 15 seconds

let pollingInterval: ReturnType<typeof setInterval> | null = null;

// ──────────────────────────────────────────────────────────────────────────────
// STATE MANAGEMENT
// ──────────────────────────────────────────────────────────────────────────────

async function ensureBotState() {
  const [existing] = await db.select().from(botStateTable).limit(1);
  if (!existing) {
    await db.insert(botStateTable).values({
      running: true,   // auto-start in TEST mode on fresh deployment
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
      minEdgeThreshold: 0.19,  // data-driven: 19–21% edge → 75–90% win rate
      sizingMode: "kelly",
      flatSizeUsdc: 1.0,
      lossStreak: 0,
      sizingMultiplier: 1.0,
      dailyStartBalance: 20,
      weeklyStartBalance: 20,
      dailyStopTriggered: false,
      weeklyStopTriggered: false,
      drawdownPaused: false,
      dailyTradeCount: 0,
    });
    const [state] = await db.select().from(botStateTable).limit(1);
    _updateStateCache(state);
    return state;
  }
  _updateStateCache(existing);
  return existing;
}

export async function getBotState() {
  // Serve from in-memory cache if still fresh — avoids a DB round-trip for
  // every 3-second status poll (especially important on Render where the DB
  // is a remote server and each query adds 50-200 ms of latency).
  if (_stateCache && Date.now() - _stateCacheTs < STATE_CACHE_TTL) {
    return _stateCache;
  }
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
      minEdgeThreshold: opts.minEdgeThreshold ?? 0.19, // data-driven: 19–21% edge sweet spot
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

export async function setSmartExit(enabled: boolean) {
  const [state] = await db.select().from(botStateTable).limit(1);
  if (!state) throw new Error("Bot state not found");
  await db.update(botStateTable).set({ smartExit: enabled, lastUpdated: new Date() }).where(eq(botStateTable.id, state.id));
  console.log(`[BOT] Smart exit ${enabled ? "ENABLED" : "DISABLED"}`);
  const [updated] = await db.select().from(botStateTable).limit(1);
  _updateStateCache(updated);
  return updated;
}

export async function setSniperMode(mode: "late" | "edge" | "both") {
  const state = await ensureBotState();
  await db
    .update(botStateTable)
    .set({ sniperMode: mode, lastUpdated: new Date() })
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
  // Start order-flow feeds (idempotent — safe to call multiple times)
  startOrderFlow();
  // WebSocket feeds BTC price in real-time; cycle can be fast without rate-limit risk.
  // 1.5-second cycle gives 20+ data points in the critical 10–40s entry window,
  // and halves the stop-loss detection lag when prices gap through the threshold.
  pollingInterval = setInterval(() => {
    runBotCycle(botId).catch((err) => {
      console.error("[BOT] Unhandled error in bot cycle — server continues running:", err);
    });
  }, 1_500);
  runBotCycle(botId).catch((err) => {
    console.error("[BOT] Unhandled error in bot cycle — server continues running:", err);
  });
}

/**
 * Recompute totalTrades / winningTrades / losingTrades / totalPnl from the
 * actual closed trade records. Fixes any double-counting from previous bugs
 * (e.g. the BUY-confirmation + resolution double-increment).
 */
async function recalculateTradeStats(botId: number): Promise<void> {
  try {
    const [result] = await db.select({
      totalTrades:   sql<number>`count(*) filter (where status = 'closed')`,
      winningTrades: sql<number>`count(*) filter (where status = 'closed' and pnl > 0)`,
      losingTrades:  sql<number>`count(*) filter (where status = 'closed' and pnl <= 0)`,
      totalPnl:      sql<number>`coalesce(sum(pnl) filter (where status = 'closed'), 0)`,
    }).from(tradesTable);

    if (!result) return;

    const totalTrades   = Number(result.totalTrades)   || 0;
    const winningTrades = Number(result.winningTrades)  || 0;
    const losingTrades  = Number(result.losingTrades)   || 0;
    const totalPnl      = Number(result.totalPnl)       || 0;

    await db.update(botStateTable).set({
      totalTrades, winningTrades, losingTrades, totalPnl, lastUpdated: new Date(),
    }).where(eq(botStateTable.id, botId));

    console.log(`[BOT] Stats recalculated: ${totalTrades} trades (${winningTrades}W / ${losingTrades}L), PnL $${totalPnl.toFixed(4)}`);
  } catch (err) {
    console.error("[BOT] Stats recalculation failed:", err);
  }
}

export async function autoResumeBot() {
  const state = await ensureBotState();
  if (pollingInterval !== null) return; // already polling

  // Correct any double-counted stats from prior bug before displaying or trading
  await recalculateTradeStats(state.id);

  if (state.running) {
    console.log(`[BOT] Auto-resuming ${state.mode.toUpperCase()} bot (balance $${state.balance?.toFixed(2)}) after restart`);
    startPolling(state.id);
  } else {
    // Always auto-start on server restart — Render redeploys frequently and
    // the user expects the bot to keep running. They can stop it manually.
    // Only skip if drawdown stop is active (safety).
    if (state.drawdownPaused) {
      console.log(`[BOT] STANDBY — drawdown stop active. Manual start required.`);
      return;
    }
    const reason = state.totalTrades === 0 ? "fresh state" : `${state.totalTrades} prior trades, resuming after restart`;
    console.log(`[BOT] Auto-starting ${state.mode.toUpperCase()} bot (balance $${state.balance?.toFixed(2)}) — ${reason}`);
    await db.update(botStateTable).set({ running: true, lastUpdated: new Date() }).where(eq(botStateTable.id, state.id));
    _updateStateCache({ ...state, running: true, lastUpdated: new Date() });
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
    // Always sweep LIVE positions first — handles trades from previous LIVE sessions
    // even if the bot is currently in TEST mode (e.g. after a mode switch or restart).
    await resolve5mLivePositions(botId);
    if (state.mode === "test") {
      await resolve5mTestPositions(botId, btcData.currentPrice);
    }

    // Re-read state after potential balance updates from closures
    let [freshState] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
    if (!freshState?.running) return;

    // ── Proactive daily trade count reset at UTC midnight ─────────────────────
    // updateDrawdownProtection only resets the count after a trade closes; if no
    // trade closes by midnight the count carries over forever. Check here every
    // cycle so the reset happens within 1-2 seconds of midnight regardless.
    {
      const todayStr = new Date().toISOString().slice(0, 10);
      const lastDay  = freshState.lastUpdated?.toISOString().slice(0, 10);
      if (lastDay && lastDay < todayStr && (freshState.dailyTradeCount ?? 0) > 0) {
        console.log(`[BOT] New UTC day (${todayStr}) — resetting daily trade count from ${freshState.dailyTradeCount} to 0`);
        await db.update(botStateTable).set({ dailyTradeCount: 0, lastUpdated: new Date() })
          .where(eq(botStateTable.id, botId));
        freshState = { ...freshState, dailyTradeCount: 0 };
      }
    }

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

    // ── Step 2: 5m market signal + order-flow overlay ────────────────────────
    // Track window transitions so in-window delta knows where BTC opened
    updateWindowOpen(market5m.windowEnd, btcData.currentPrice);
    const flow = getOrderFlowData(btcData.currentPrice);

    // prob_up = our estimated probability that BTC ends this window HIGHER.
    // Pass secondsRemaining so the model can apply time-aware weighting:
    // in the final 50s, short-term tick velocity dominates over in-window delta.
    const probUp = estimate5mUpProb(btcData, flow, market5m.secondsRemaining);
    const upPrice = market5m.upPrice;
    const downPrice = market5m.downPrice;

    // Edge: positive means BUY UP, negative means BUY DOWN
    const edgeUp = probUp - upPrice;
    const isBuyUp = edgeUp > 0;
    const direction: "YES" | "NO" = isBuyUp ? "YES" : "NO"; // YES=UP, NO=DOWN in DB
    const entryPrice = isBuyUp ? upPrice : downPrice;
    const winProb = isBuyUp ? probUp : 1 - probUp;
    const edge = isBuyUp ? edgeUp : -edgeUp; // always positive

    // ── Entry window — varies by sniperMode ──────────────────────────────────
    // "late": classic late-cycle snipe — enter only in final 5–40 s
    // "edge": mid-window snipe — enter when 41–240 s remain (after 1st minute),
    //         exit early via TP (8¢) or signal flip; multiple entries per window
    // "both": try edge snipes mid-window AND a late snipe in the final 40 s
    const sniperMode = freshState.sniperMode ?? "late";
    let entryMax: number;
    let entryMin: number;
    if (sniperMode === "edge") {
      entryMax = EDGE_ENTRY_MAX;
      entryMin = EDGE_ENTRY_MIN;
    } else if (sniperMode === "both") {
      entryMax = EDGE_ENTRY_MAX;  // covers 5–240 s (both zones)
      entryMin = LATE_ENTRY_MIN;
    } else {
      entryMax = LATE_ENTRY_MAX;
      entryMin = LATE_ENTRY_MIN;
    }
    const tooEarly = market5m.secondsRemaining > entryMax;
    const tooLate  = market5m.secondsRemaining < entryMin;

    // ── isEdgeMode: true when sniper mode is 'edge' or 'both' ──
    // Declared here so it's available to both the entry filter block AND the TP/SL block below.
    const isEdgeMode = (freshState.sniperMode ?? "late") !== "late";

    let signal: "BUY_YES" | "BUY_NO" | "NO_TRADE" = "NO_TRADE";
    let positionSize = 0;
    let shares = 0;

    // ── Mode-aware entry filters ──────────────────────────────────────────────
    //
    // LATE mode (final 40s, hold to binary resolution):
    //   - Prices converge toward $0/$1 in the final 40s — dead zones from EDGE data don't apply
    //   - Lower edge threshold (8%) is sufficient: we hold to binary outcome, no SL noise
    //   - Higher certainty cap (0.92): late-stage prices naturally push toward extremes
    //   - No edge cap: high-edge = low market price = bigger payout on binary win
    //
    // EDGE mode (1–4 min before end, 8¢ SL/TP):
    //   - Prices are mid-range and volatile — dead zone analysis applies
    //   - Higher edge threshold required to overcome SL noise (19–21%)
    //   - Edge cap required (market right at extremes when time remains)

    const LATE_MIN_EDGE      = 0.08;  // 8%  — any model edge this large pays with binary resolution
    const EDGE_MAX_CERTAINTY = 0.75;  // 75¢ cap in EDGE — still 4+ min of repricing risk
    // LATE mode: only enter when entry side is in the 30–80¢ sweet spot.
    // Below 30¢ = long-shot with thin expected value; above 80¢ = overpriced, upside too small.
    const LATE_MIN_PRICE = 0.50;
    const LATE_MAX_PRICE = 0.80;

    const priceTooCertain = isEdgeMode
      ? (Math.max(upPrice, downPrice) > EDGE_MAX_CERTAINTY || entryPrice < 0.50)
      : entryPrice < LATE_MIN_PRICE || entryPrice > LATE_MAX_PRICE;

    // Dead-zone filter (EDGE mode only — price zones where model consistently underperforms
    // with 8¢ SL. These zones were calibrated on 108 EDGE mode trades and are INVALID for LATE mode
    // where the price converges to binary in the final 40s).
    const safeEdge = typeof edge === "number" ? edge : 0;
    const safeIsEdgeMode = typeof isEdgeMode === "boolean" ? isEdgeMode : false;

    // ✅ define ONCE, outside
    const btc1m = btcData.change1m ?? 0;
    const dynamicEdgeThreshold = 0.04 + Math.abs(btc1m || 0) * 2;
    
    // ✅ safety check (optional but clean)
    if (typeof edge !== "number") {
      console.log("EDGE UNDEFINED", edge);
    }
    
    // ✅ condition (ONLY boolean logic inside)
    const inNoMansLand = isEdgeMode && (
      upPrice >= 0.45 &&
      upPrice <= 0.55 &&
      edge < dynamicEdgeThreshold
    );

    

    // Edge threshold — LATE uses a flat 8%; EDGE uses the direction-aware stored threshold
    const directionEdgeThreshold = isEdgeMode
      ? (isBuyUp
          ? freshState.minEdgeThreshold + 0.02  // 21% for YES in EDGE
          : freshState.minEdgeThreshold)         // 19% for NO in EDGE
      : LATE_MIN_EDGE;                           // 8% flat for LATE

    // Apply sizing multiplier from drawdown protection (0.5 after 5 loss streak)
    const sizingMultiplier = freshState.sizingMultiplier ?? 1.0;

    // Edge cap — EDGE mode only (in LATE mode, high-edge = big payout from binary win)
    const baseEdgeCap = isBuyUp ? MAX_EDGE_THRESHOLD_YES : MAX_EDGE_THRESHOLD_NO;
    const effectiveEdgeCap = flow.flowConfirmed ? 0.38 : baseEdgeCap;
    const edgeTooHigh = isEdgeMode && (edge > effectiveEdgeCap);

    // Daily trade limit — safety valve; resets at UTC midnight
    const dailyLimitHit = (freshState.dailyTradeCount ?? 0) >= MAX_DAILY_TRADES;

    const minBalance = freshState.sizingMode === "flat" ? freshState.flatSizeUsdc : 0.5;
    // Record CLOB price for drift detection (only while in the late entry window)
    if (!isEdgeMode && !tooEarly) {
      recordLatePriceSample(market5m.windowEnd, upPrice);
    }

    // ── Price-drift guard (LATE mode only) ────────────────────────────────────
    // If the CLOB has been running ≥ LATE_PRICE_DRIFT_GUARD cents against our
    // intended direction in the last 15 seconds, the market has momentum we
    // can't overcome in the remaining window — skip entry.
    let driftBlocked = false;
    if (!isEdgeMode && !tooEarly && !tooLate) {
      const oldUpPrice = priceBeforeDriftWindow(market5m.windowEnd);
      if (oldUpPrice !== null) {
        // For BUY_YES we need upPrice to be stable/rising.  Adverse drift = upPrice fell.
        // For BUY_NO we need downPrice (= 1-upPrice) to be stable/rising.  Adverse drift = upPrice rose.
        const drift = isBuyUp
          ? oldUpPrice - upPrice       // positive = upPrice fell = adverse for YES buyer
          : upPrice - oldUpPrice;      // positive = upPrice rose = adverse for NO buyer
        if (drift >= LATE_PRICE_DRIFT_GUARD) {
          driftBlocked = true;
        }
      }
    }

    // ── Minimum model confidence gate (LATE mode only) ────────────────────────
    // Require the model to be at least 57% confident in OUR DIRECTION before entering.
    // This prevents entries where the edge comes from a very weak 50-53% model signal
    // betting against a market at 42-45¢ — barely-above-random predictions with full
    // binary loss exposure. At 57% we have meaningful directional conviction.
    // EDGE mode: not applied — EDGE mode has higher explicit edge thresholds.
    const MIN_LATE_MODEL_CONFIDENCE = 0.57;
    const lowModelConfidence = !isEdgeMode && winProb < MIN_LATE_MODEL_CONFIDENCE;

    // ── BTC velocity direction confirmation (LATE mode only) ──────────────────
    // The 5-second BTC tick velocity is the primary front-running signal in LATE mode.
    // If the very-short-term BTC movement CONFLICTS with our model direction (e.g., model
    // says UP but BTC fell in the last 5s), the market is likely already repricing against
    // us — skip entry. This prevents chasing moves that have already reversed.
    // A near-zero velocity (< 0.005%) is treated as neutral (no conflict block).
    const BTC_VELOCITY_CONFLICT_MIN = 0.005; // 0.005% = ~$4 BTC move — must be meaningful to block
    const btcVelocity5s = btcData.change5s ?? 0;
    const velocityConflict = !isEdgeMode && !tooEarly && !tooLate &&
      Math.abs(btcVelocity5s) >= BTC_VELOCITY_CONFLICT_MIN &&
      (isBuyUp ? btcVelocity5s < 0 : btcVelocity5s > 0);  // velocity opposes our signal

    if (!tooEarly && !tooLate && !priceTooCertain && !inNoMansLand && !edgeTooHigh && !dailyLimitHit && !driftBlocked && !lowModelConfidence && !velocityConflict && edge >= directionEdgeThreshold && freshState.balance >= minBalance) {
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

      // Hard cap: never risk more than MAX_POSITION_PCT of balance on one trade,
      // regardless of what Kelly recommends (protects against extreme edge estimates).
      const hardCap = freshState.balance * MAX_POSITION_PCT;
      if (positionSize > hardCap) {
        positionSize = hardCap;
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
    const chg5s    = (btcData.change5s ?? 0) >= 0 ? `+${(btcData.change5s ?? 0).toFixed(3)}%` : `${(btcData.change5s ?? 0).toFixed(3)}%`;
    if (signal === "NO_TRADE") {
      const certainSide = upPrice > downPrice ? `UP=${(upPrice*100).toFixed(1)}¢` : `DOWN=${(downPrice*100).toFixed(1)}¢`;
      const reason = tooEarly ? `TOO_EARLY (${market5m.secondsRemaining}s left, wait for ≤${entryMax}s)`
        : tooLate  ? `TOO_LATE (${market5m.secondsRemaining}s left, min ${entryMin}s)`
        : priceTooCertain ? (isEdgeMode
            ? `PRICE_CAP (${certainSide} > ${(EDGE_MAX_CERTAINTY*100).toFixed(0)}¢ max)`
            : entryPrice < LATE_MIN_PRICE
              ? `PRICE_LOW (entry ${(entryPrice*100).toFixed(1)}¢ < 40¢ min)`
              : `PRICE_HIGH (entry ${(entryPrice*100).toFixed(1)}¢ > 80¢ max)`)
        : inNoMansLand ? `NO_MANS_LAND (UP=${(upPrice*100).toFixed(1)}¢ — EDGE dead zone)`
        : edgeTooHigh ? `EDGE_TOO_HIGH (${edgePct}% > ${(effectiveEdgeCap*100).toFixed(0)}% cap${flow.flowConfirmed ? " [flow-confirmed cap]" : ""})`
        : dailyLimitHit ? `DAILY_LIMIT (${freshState.dailyTradeCount ?? 0}/${MAX_DAILY_TRADES} trades today)`
        : driftBlocked ? `DRIFT_BLOCKED (market running ${isBuyUp ? "against YES" : "against NO"} entry — ≥${(LATE_PRICE_DRIFT_GUARD*100).toFixed(0)}¢ in ${LATE_PRICE_DRIFT_WINDOW_MS/1000}s)`
        : lowModelConfidence ? `LOW_CONFIDENCE (model=${(winProb*100).toFixed(1)}% < ${(MIN_LATE_MODEL_CONFIDENCE*100).toFixed(0)}% min — weak signal, skip)`
        : velocityConflict ? `VELOCITY_CONFLICT (BTC 5s=${chg5s} opposes ${isBuyUp ? "UP" : "DOWN"} signal — market already repricing)`
        : `edge ${edgePct}% < ${isEdgeMode ? (isBuyUp ? "YES" : "NO") + " EDGE" : "LATE"} threshold ${(directionEdgeThreshold*100).toFixed(1)}%`;
      // Throttle: with 3s cycles, log at most once per 15s to reduce noise.
      // Always log if we're in (or near) the entry window.
      const inOrNearWindow = !tooEarly;
      if (inOrNearWindow || Date.now() - _lastNoTradeLogAt > NO_TRADE_LOG_THROTTLE_MS) {
        _lastNoTradeLogAt = Date.now();
        const flowTag = `OBI=${flow.obImbalance >= 0 ? "+" : ""}${flow.obImbalance.toFixed(2)} Δwin=${flow.inWindowDelta >= 0 ? "+" : ""}${flow.inWindowDelta.toFixed(3)}% 5s=${chg5s}${flow.flowConfirmed ? " ✓FLOW" : ""}`;
        console.log(`[5M] NO_TRADE | UP=${upPct}¢ DOWN=${downPct}¢ model=${probUpPct}% btc1m=${chg1m} ${flowTag} | ${reason} | ${secStr}`);
      }
    } else {
      const sizeTag = sizingMultiplier < 1 ? ` [×${sizingMultiplier} drawdown]` : "";
      const flowTag = flow.flowConfirmed ? ` ✓FLOW(OBI=${flow.obImbalance >= 0 ? "+" : ""}${flow.obImbalance.toFixed(2)},Δ${flow.inWindowDelta >= 0 ? "+" : ""}${flow.inWindowDelta.toFixed(3)}%)` : "";
      const dir = isBuyUp ? "BUY_UP" : "BUY_DOWN";
      console.log(`[5M] ${dir} | UP=${upPct}¢ DOWN=${downPct}¢ model=${probUpPct}% btc1m=${chg1m} 5s=${chg5s} edge=+${edgePct}%${flowTag} size=$${positionSize.toFixed(2)}${sizeTag} | ${secStr}`);
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
      const sniperModeStr = freshState.sniperMode ?? "late";
      const holdMinMs = freshState.mode === "test"
        ? (isEdgeMode ? EDGE_HOLD_MS : TEST_HOLD_MS)
        : (isEdgeMode ? EDGE_HOLD_MS : LIVE_MIN_HOLD_MS);
      const tpTarget = isEdgeMode ? EDGE_TAKE_PROFIT : TAKE_PROFIT_MARKET_GAIN;
      const openPositions = await db.select().from(tradesTable)
        .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, freshState.mode)));

      if (openPositions.length > 0) {
        const pos = openPositions[0];

        // LIVE: only apply TP when the position belongs to the current 5m window
        const posInfo = decode5mMarketId(pos.marketId ?? "");
        const inCurrentWindow = freshState.mode === "test" || (posInfo && posInfo.windowEnd === market5m.windowEnd);

        if (inCurrentWindow && !pendingSellTradeIds.has(pos.id)) {
          const heldMs = Date.now() - pos.timestamp.getTime();

          // Pre-compute market gain (used for both immediate SL and time-gated TP/smart-exit)
          const weBoughtUp = pos.direction === "YES";
          const currentHeldPrice = weBoughtUp ? upPrice : 1 - upPrice;
          const entryHeldPrice   = weBoughtUp ? pos.marketPrice : 1 - pos.marketPrice;
          const marketGain = currentHeldPrice - entryHeldPrice;
          const dir = weBoughtUp ? "UP" : "DOWN";

          // ── Stop-loss: fires IMMEDIATELY (no hold-time gate) ─────────────
          // The SL must be able to fire the moment the threshold is hit.
          // Gating it behind holdMinMs in a 50s window means it can never
          // fire in time — that was the reason SL wasn't working in LIVE mode.
          // IMPORTANT: skip if pos.shares=0 (BUY not yet matched by CLOB);
          //   a 0-share SELL would record $0.00 P&L and not actually exit.
          const slThreshold = isEdgeMode ? EDGE_STOP_LOSS : LATE_STOP_LOSS;
          if (marketGain <= -slThreshold) {
            if (pos.shares > 0) {
              const estPnl = pos.shares * marketGain;
              const slLabel = isEdgeMode ? "STOP-LOSS" : "STOP-LOSS(LATE)";
              console.log(
                `[5M ${modeStr}] ${slLabel} ${dir} | market -${Math.abs(marketGain * 100).toFixed(1)}¢ ` +
                `(${(entryHeldPrice * 100).toFixed(1)}¢ → ${(currentHeldPrice * 100).toFixed(1)}¢) | ` +
                `est P&L $${estPnl.toFixed(4)} | held ${Math.round(heldMs/1000)}s`
              );
              if (freshState.mode === "test") {
                await closeTestPositionEarly(botId, pos, upPrice);
              } else {
                const preloadedTid = weBoughtUp ? market5m.upTokenId : market5m.downTokenId;
                await closeLivePositionEarly(botId, pos, upPrice, market5m.conditionId, "STOP_LOSS", preloadedTid);
              }
              return;
            } else {
              console.log(`[5M ${modeStr}] SL triggered but shares=0 (BUY unmatched) — holding for binary resolution`);
            }
          }

          if (heldMs >= holdMinMs) {
            const gainCents = (marketGain * 100).toFixed(1);
            const tpCents   = (tpTarget * 100).toFixed(0);
            const gainSign  = marketGain >= 0 ? "+" : "";
            console.log(
              `[5M ${modeStr}] Holding ${dir} | market ${(entryHeldPrice*100).toFixed(1)}¢ → ` +
              `${(currentHeldPrice*100).toFixed(1)}¢ (${gainSign}${gainCents}¢ of ${tpCents}¢ TP target)`
            );

            if (marketGain >= tpTarget) {
              const estPnl = pos.shares * marketGain;
              console.log(
                `[5M ${modeStr}] Take-profit ${dir} | market +${(marketGain * 100).toFixed(1)}¢ ` +
                `(${(entryHeldPrice * 100).toFixed(1)}¢ → ${(currentHeldPrice * 100).toFixed(1)}¢) | ` +
                `est P&L +$${estPnl.toFixed(4)}`
              );
              if (freshState.mode === "test") {
                await closeTestPositionEarly(botId, pos, upPrice);
              } else {
                const preloadedTid = weBoughtUp ? market5m.upTokenId : market5m.downTokenId;
                await closeLivePositionEarly(botId, pos, upPrice, market5m.conditionId, "TAKE_PROFIT", preloadedTid);
              }
              // Do NOT re-enter immediately — wait for price to pull back.
              return;
            }

            // ── Smart exit (LATE mode only, when enabled) ─────────────────────
            // If the model's estimated win probability for our position has dropped
            // below LATE_SMART_EXIT_PROB, the momentum has reversed and holding to
            // binary resolution is likely to result in a full loss. Exit early at
            // the current Polymarket market price to recover partial value.
            if (!isEdgeMode && (freshState.smartExit ?? true)) {
              const modelWinProb = weBoughtUp ? probUp : 1 - probUp;
              if (modelWinProb < LATE_SMART_EXIT_PROB) {
                const estPnl = pos.shares * marketGain;
                console.log(
                  `[5M ${modeStr}] SMART EXIT ${dir} | model win prob ${(modelWinProb*100).toFixed(1)}% < ${(LATE_SMART_EXIT_PROB*100).toFixed(0)}% threshold ` +
                  `| market ${gainSign}${gainCents}¢ | est P&L $${estPnl.toFixed(4)}`
                );
                if (freshState.mode === "test") {
                  await closeTestPositionEarly(botId, pos, upPrice);
                } else {
                  const preloadedTid = weBoughtUp ? market5m.upTokenId : market5m.downTokenId;
                  await closeLivePositionEarly(botId, pos, upPrice, market5m.conditionId, "SMART_EXIT", preloadedTid);
                }
                return;
              }
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

        const flipHoldMinMs = (freshState.sniperMode ?? "late") !== "late" ? EDGE_HOLD_MS : TEST_HOLD_MS;
        if (signalFlipped && heldMs >= flipHoldMinMs) {
          // Signal reversed after minimum hold — exit at Polymarket market price
          // (simulates selling tokens at the real bid, which barely moves in these
          // illiquid markets, giving ~$0 P&L on exit) then open the other side.
          await closeTestPositionEarly(botId, pos, upPrice);
          const [updatedState] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
          if (!updatedState || updatedState.balance < 1.0) return;
          const newSize  = Math.min(positionSize, updatedState.balance);
          const newShares = entryPrice > 0 ? newSize / entryPrice : 0;
          // Apply slippage in EDGE mode: entry at ask (midpoint + 1¢) for honest simulation
          const flipSlippedPrice = isEdgeMode
            ? (direction === "YES" ? upPrice + ENTRY_SLIPPAGE : upPrice - ENTRY_SLIPPAGE)
            : upPrice;
          await openTestPosition(botId, updatedState, {
            direction, marketPrice: flipSlippedPrice, edge, evPerShare,
            kellyScaledPct: newSize / updatedState.balance, positionSize: newSize, shares: newShares, priceImpact: 0,
          }, btcData.currentPrice, marketId);
        } else if (signalFlipped) {
          console.log(`[5M TEST] Flip signal (${pos.direction}→${direction}) but held only ${Math.round(heldMs/1000)}s — waiting for ${flipHoldMinMs/1000}s min`);
        }
        return;
      }

      // Apply slippage in EDGE mode: entry at ask (midpoint + 1¢) for honest simulation
      const slippedMarketPrice = isEdgeMode
        ? (direction === "YES" ? upPrice + ENTRY_SLIPPAGE : upPrice - ENTRY_SLIPPAGE)
        : upPrice;
      await openTestPosition(botId, freshState, {
        direction, marketPrice: slippedMarketPrice, edge, evPerShare,
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

        const liveFlipHoldMs = (freshState.sniperMode ?? "late") !== "late" ? EDGE_HOLD_MS : LIVE_MIN_HOLD_MS;
        if (inCurrentWindow && signalFlipped && heldMs >= liveFlipHoldMs) {
          // Signal reversed — exit current position and allow re-entry in same window
          console.log(`[LIVE] Flip signal (${pos.direction}→${direction}) after ${Math.round(heldMs/1000)}s — queuing SELL`);
          const preloadedTid = pos.direction === "YES" ? market5m.upTokenId : market5m.downTokenId;
          const flipped = await closeLivePositionEarly(botId, pos, upPrice, market5m.conditionId, "FLIP", preloadedTid);
          if (flipped) attemptedWindowEnds.delete(market5m.windowEnd); // allow re-entry this window
        } else if (inCurrentWindow && signalFlipped) {
          console.log(`[LIVE] Flip signal (${pos.direction}→${direction}) but held only ${Math.round(heldMs/1000)}s — waiting for ${liveFlipHoldMs/1000}s min`);
        }
        // else: holding same direction (log already shown in step 3a TP check)
        return;
      }
      // Guard 1: order queued in memory but not yet dequeued by relay
      const hasPendingBuy = browserOrderQueue.some(o => o.botId === botId && o.tradeContext.orderSide === "BUY");
      // Guard 2: order dequeued by relay but completeBrowserOrder() not yet called (race window)
      const hasInFlightBuy = inFlightBuyWindows.has(botId) && inFlightBuyWindows.get(botId) === market5m.windowEnd;
      if (hasPendingBuy || hasInFlightBuy) {
        console.log(`[LIVE] Skipping — BUY already ${hasPendingBuy ? "queued" : "in-flight with relay"}, awaiting confirmation`);
        return;
      }

      // Guard 3: window already attempted (in-memory — survives across cycles but resets on restart)
      if (attemptedWindowEnds.has(market5m.windowEnd)) {
        console.log(`[LIVE] Already attempted window ${new Date(market5m.windowEnd * 1000).toISOString()} — waiting for next window`);
        return;
      }

      // Guard 4: DB-level backstop — check for any open live position in this window
      // Catches cases where the server restarted after placing an order (in-memory guards cleared)
      const existingOpenInWindow = await db.select({ id: tradesTable.id, marketId: tradesTable.marketId })
        .from(tradesTable)
        .where(and(eq(tradesTable.status, "open"), eq(tradesTable.mode, "live")));
      const windowAlreadyOpen = existingOpenInWindow.some(t => {
        const info = decode5mMarketId(t.marketId ?? "");
        return info && info.windowEnd === market5m.windowEnd;
      });
      if (windowAlreadyOpen) {
        console.log(`[LIVE] DB check: open live position already exists for window ${new Date(market5m.windowEnd * 1000).toISOString()} — skipping`);
        attemptedWindowEnds.add(market5m.windowEnd); // sync in-memory guard with reality
        return;
      }

      const tokenId = direction === "YES" ? market5m.upTokenId : market5m.downTokenId;
      const tradeResult = await executeLiveTrade(botId, freshState, {
        direction, marketPrice: upPrice, edge, evPerShare,
        kellyScaledPct: positionSize / freshState.balance, positionSize, shares, priceImpact: 0,
      }, btcData.currentPrice, marketId, market5m.conditionId, tokenId, isEdgeMode);

      // Mark window attempted only when order was placed or failed for a non-geoblock,
      // non-slippage reason.
      // - Geoblock: leave open so browser relay / proxy can retry.
      // - Slippage skip: leave open so the bot retries if price comes back into range.
      // - Genuine attempt (success or non-retriable failure): lock the window.
      if (!tradeResult?.geoblocked && !tradeResult?.slippageSkip) {
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

  // Reset daily trade count at UTC midnight
  const dailyTradeCount = isNewDay ? 0 : (st.dailyTradeCount ?? 0);

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
    dailyTradeCount,
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
// MANUAL CANCEL — force-cancel an open LIVE or TEST position
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Manually cancel an open trade:
 *  - For LIVE trades: attempts to cancel the on-chain order via Polymarket API
 *    (best-effort; proceeds even if the cancel call fails since the window may
 *    have already expired).
 *  - Marks the DB record as "cancelled" and refunds positionSize to balance.
 *  - Decrements dailyTradeCount so the cancelled trade doesn't burn a slot.
 */
export async function cancelLivePosition(tradeId: number): Promise<{ ok: boolean; message: string }> {
  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, tradeId));
  if (!trade) return { ok: false, message: `Trade #${tradeId} not found` };
  if (trade.status !== "open") return { ok: false, message: `Trade #${tradeId} is already ${trade.status}` };

  const info = decode5mMarketId(trade.marketId ?? "");
  const orderId = info?.orderId ?? null;

  // Attempt to cancel the order at Polymarket (LIVE trades only, best-effort)
  if (trade.mode === "live" && orderId) {
    try {
      const { cancelOrder } = await import("./polymarketOrder.js");
      const cancelled = await cancelOrder(orderId);
      console.log(`[CANCEL] Polymarket cancel for order ${orderId}: ${cancelled ? "OK" : "failed/already settled"}`);
    } catch (err) {
      console.warn(`[CANCEL] Polymarket cancel attempt threw:`, err);
    }
  }

  // Remove from in-flight and pending sets
  if (info?.windowEnd) {
    inFlightBuyWindows.delete(info.windowEnd);
    attemptedWindowEnds.delete(info.windowEnd);
  }
  pendingSellTradeIds.delete(tradeId);
  resolvingTradeIds.delete(tradeId);

  // Mark cancelled in DB and refund balance
  const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, trade.botId));
  if (!st) return { ok: false, message: "Bot state not found" };

  await db.update(tradesTable).set({ status: "cancelled", resolvedAt: new Date() })
    .where(eq(tradesTable.id, tradeId));

  await db.update(botStateTable).set({
    balance: st.balance + trade.positionSize,
    dailyTradeCount: Math.max(0, (st.dailyTradeCount ?? 1) - 1),
    lastUpdated: new Date(),
  }).where(eq(botStateTable.id, trade.botId));

  console.log(`[CANCEL] Trade #${tradeId} (${trade.mode.toUpperCase()} ${trade.direction}) force-cancelled — $${trade.positionSize.toFixed(2)} refunded`);
  return { ok: true, message: `Trade #${tradeId} cancelled, $${trade.positionSize.toFixed(2)} refunded` };
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
      const secsSinceCloseEarly = nowSec - info.windowEnd;

      const clobRes = await fetch(`https://clob.polymarket.com/markets/${info.conditionId}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!clobRes.ok) {
        console.warn(`[LIVE 5M] CLOB fetch failed (${clobRes.status}) for ${info.conditionId} | ${secsSinceCloseEarly}s since close`);

        // If the market is old enough that CLOB has archived it, close the trade
        // by syncing the actual wallet balance as source of truth.
        if (secsSinceCloseEarly >= 90) {
          console.log(`[LIVE 5M] Trade #${pos.id} stale (${Math.floor(secsSinceCloseEarly / 60)}min past close) — closing via wallet balance sync`);
          const walletBal = await getWalletBalance();
          const [st2] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
          if (walletBal !== null && st2) {
            // pnl = wallet_change relative to what we'd have without this trade resolving
            // db_balance already deducted positionSize, so: pnl = walletBal - st2.balance - pos.positionSize
            const pnl = walletBal - st2.balance - pos.positionSize;
            const weWon = pnl > -pos.positionSize * 0.5; // won if we got back more than half
            console.log(`[LIVE 5M] Wallet-sync close: wallet=$${walletBal.toFixed(2)} db=$${st2.balance.toFixed(2)} posSize=$${pos.positionSize.toFixed(2)} → pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);
            await db.update(tradesTable).set({
              status: "closed",
              exitPrice: weWon ? 1.0 : 0.0,
              pnl,
              resolvedAt: new Date(),
            }).where(eq(tradesTable.id, pos.id));
            await db.update(botStateTable).set({
              balance: walletBal,
              totalTrades: st2.totalTrades + 1,
              winningTrades: weWon ? st2.winningTrades + 1 : st2.winningTrades,
              losingTrades: weWon ? st2.losingTrades : st2.losingTrades + 1,
              totalPnl: st2.totalPnl + pnl,
              lastUpdated: new Date(),
            }).where(eq(botStateTable.id, botId));
            console.log(`[LIVE 5M] Stale trade #${pos.id} closed via wallet sync — ${weWon ? "WON" : "LOST"} | balance: $${walletBal.toFixed(2)}`);
          }
        }
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

      // Primary: official winner flag. Fallback: price ≥ 0.82 after window closed ≥ 5s
      // (Polymarket's oracle can lag 2-5 min; prices already reflect the winner by then)
      const secsSinceClose = nowSec - info.windowEnd;
      const priceResolutionOk = secsSinceClose >= 5;
      const upWon  = upToken?.winner  === true || (priceResolutionOk && upPrice  >= 0.82);
      const downWon = downToken?.winner === true || (priceResolutionOk && downPrice >= 0.82);

      if (!upWon && !downWon) {
        console.log(`[LIVE 5M] Market not yet resolved (closed=${clobData.closed}, UP=${(upPrice*100).toFixed(1)}¢, DOWN=${(downPrice*100).toFixed(1)}¢, ${secsSinceClose}s since close) — waiting`);

        // If the oracle hasn't set winner flags after 90s, fall back to wallet sync
        // (handles manual redemptions and oracle delays on live markets)
        if (secsSinceClose >= 90) {
          console.log(`[LIVE 5M] Trade #${pos.id} oracle timeout (${secsSinceClose}s) — closing via wallet balance sync`);
          const walletBal = await getWalletBalance();
          const [st2] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
          if (walletBal !== null && st2) {
            const pnl = walletBal - st2.balance - pos.positionSize;
            const weWon = pnl > -pos.positionSize * 0.5;
            console.log(`[LIVE 5M] Wallet-sync close: wallet=$${walletBal.toFixed(2)} db=$${st2.balance.toFixed(2)} → pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`);
            await db.update(tradesTable).set({
              status: "closed", exitPrice: weWon ? 1.0 : 0.0, pnl, resolvedAt: new Date(),
            }).where(eq(tradesTable.id, pos.id));
            await db.update(botStateTable).set({
              balance: walletBal,
              totalTrades: st2.totalTrades + 1,
              winningTrades: weWon ? st2.winningTrades + 1 : st2.winningTrades,
              losingTrades: weWon ? st2.losingTrades : st2.losingTrades + 1,
              totalPnl: st2.totalPnl + pnl,
              lastUpdated: new Date(),
            }).where(eq(botStateTable.id, botId));
            console.log(`[LIVE 5M] Stale trade #${pos.id} closed (oracle timeout) — ${weWon ? "WON" : "LOST"} | balance: $${walletBal.toFixed(2)}`);
          }
        }
        continue;
      }

      const resolvedViaPrice = !upToken?.winner && !downToken?.winner;
      if (resolvedViaPrice) {
        console.log(`[LIVE 5M] Resolving via price fallback (UP=${(upPrice*100).toFixed(1)}¢ DOWN=${(downPrice*100).toFixed(1)}¢, ${secsSinceClose}s since close)`);
      }

      // ── If this order was placed as "live" (pending fill, shares=0 in DB), check actual fill ──
      if (pos.shares === 0) {
        const orderId = info.orderId;
        let actualShares = 0;
        let wasCancelled = true; // pessimistic default: assume unfilled

        if (orderId) {
          const fill = await getOrderFillStatus(orderId);
          console.log(`[LIVE 5M] Order fill check for #${pos.id} (${orderId.substring(0, 10)}...): status=${fill?.status ?? "query_failed"} sizeMatched=${fill?.sizeMatched ?? "?"}`);
          if (fill !== null) {
            actualShares = fill.sizeMatched;
            // "matched" or "delayed" means filled; "live"/"cancelled"/"unmatched" means not filled
            const filledStatuses = ["matched", "delayed"];
            wasCancelled = !filledStatuses.includes(fill.status) || actualShares === 0;
          }
          // If query failed (null), treat as cancelled — safer than falsely crediting a win
        } else {
          // No orderId stored — treat as cancelled (shouldn't happen, but be safe)
          console.warn(`[LIVE 5M] Trade #${pos.id} has shares=0 and no orderId — marking cancelled`);
        }

        if (wasCancelled) {
          console.log(`[LIVE 5M] Trade #${pos.id} was CANCELLED (order unfilled) — refunding $${pos.positionSize.toFixed(2)} to balance`);
          const [st] = await db.select().from(botStateTable).where(eq(botStateTable.id, botId));
          if (!st) { resolvingTradeIds.delete(pos.id); continue; }
          await db.update(tradesTable).set({ status: "cancelled", resolvedAt: new Date() })
            .where(eq(tradesTable.id, pos.id));
          // Refund position size AND undo the dailyTradeCount increment from when the BUY was queued.
          // Cancelled orders never filled, so they should not count against the daily trade limit.
          await db.update(botStateTable).set({
            balance: st.balance + pos.positionSize,
            dailyTradeCount: Math.max(0, (st.dailyTradeCount ?? 1) - 1),
            lastUpdated: new Date(),
          }).where(eq(botStateTable.id, botId));
          resolvingTradeIds.delete(pos.id);
          continue;
        }

        // Order was actually filled — use real share count from CLOB
        await db.update(tradesTable).set({ shares: actualShares }).where(eq(tradesTable.id, pos.id));
        (pos as typeof pos & { shares: number }).shares = actualShares;
        console.log(`[LIVE 5M] Order fill confirmed: ${actualShares.toFixed(4)} shares — proceeding to resolve`);
      }

      const weBoughtUp = pos.direction === "YES";
      const weWon = weBoughtUp ? upWon : downWon;

      const entryPrice = weBoughtUp ? pos.marketPrice : 1 - pos.marketPrice;
      const exitValue = weWon ? 1.0 : 0.0;

      // shares is now always > 0 (either DB-stored from original fill, or updated above from CLOB)
      const effectiveShares = pos.shares;
      const effectiveCost = pos.positionSize;
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
  state: { id: number; balance: number; totalTrades: number; winningTrades: number; losingTrades: number; totalPnl: number; dailyTradeCount?: number },
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

  // Reserve capital while position is open; increment daily trade count
  await db
    .update(botStateTable)
    .set({
      balance: state.balance - positionSize,
      dailyTradeCount: (state.dailyTradeCount ?? 0) + 1,
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
  reason: "TAKE_PROFIT" | "STOP_LOSS" | "SMART_EXIT" | "FLIP",
  preloadedTokenId?: string,
): Promise<boolean> {
  if (!conditionId) {
    console.warn("[LIVE] Cannot close early — no conditionId");
    return false;
  }
  if (pendingSellTradeIds.has(pos.id)) return false;

  // Guard: if BUY was never matched (shares=0), we have no tokens to sell.
  // Attempting a 0-share SELL would write $0.00 P&L and send a bad order.
  if (pos.shares <= 0) {
    console.warn(`[LIVE] Skipping early ${reason} for trade #${pos.id} — shares=0 (BUY order not yet matched by CLOB)`);
    return false;
  }

  // sellPrice is always the CLOB price for the token we hold (direction-adjusted)
  const sellPrice  = pos.direction === "YES" ? currentYesPrice : 1 - currentYesPrice;
  // entryPrice similarly direction-adjusted — needed for P&L calculation in completeBrowserOrder
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
        // BUG FIX: pass sellPrice (direction-adjusted) not raw currentYesPrice.
        // completeBrowserOrder uses marketPrice as exitPrice; for NO positions,
        // sellPrice = 1-currentYesPrice, NOT currentYesPrice. Using raw YES price
        // for a NO SELL caused inverted/zero P&L on stop-losses and early exits.
        marketPrice: sellPrice,
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
  edgeMode?: boolean,
): Promise<{ geoblocked: boolean; slippageSkip?: boolean }> {
  const { direction, marketPrice, edge, kellyScaledPct, positionSize, shares, priceImpact } = trade;

  // ── Slippage protection: re-fetch live price before placing ──
  // LATE mode: tolerate up to 15¢ slippage — prices move fast in the final 40s
  // and we need the edge to still be positive at the live price, not just < 1¢ drift.
  // EDGE mode: tight 1¢ tolerance since mid-window prices are more stable.
let slippageLimitCents = 5;

if (edge > 0.07) slippageLimitCents = 10;
if (edge > 0.10) slippageLimitCents = 15;
if (edge > 0.15) slippageLimitCents = 25;
  if (conditionId) {
    try {
      const priceRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
        signal: AbortSignal.timeout(3000),
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
       const liveProb = liveIntended; // already in probability form
const newEdge =
  direction === "YES"
    ? modelProb - liveProb
    : (1 - modelProb) - liveProb;

const maxSlippage = slippageLimitCents / 100;

// 🚨 NEW LOGIC
if (slippage > maxSlippage && newEdge < MIN_EDGE_THRESHOLD) {
  console.warn(`[LIVE] Slippage too high AND edge gone — skipping`);
  return { geoblocked: false, slippageSkip: true };
}

// ✅ OTHERWISE: TAKE THE TRADE
if (slippage > maxSlippage) {
  console.log(`[LIVE] Slippage high but edge still ${(
    newEdge * 100
  ).toFixed(2)}% — executing`);
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

  // Include live order-flow signals so the dashboard matches what the bot actually trades on.
  // Without this, the dashboard could show NO_TRADE while the bot fires a flow-enhanced order.
  if (market5m) updateWindowOpen(market5m.windowEnd, btcData.currentPrice);
  const flow = getOrderFlowData(btcData.currentPrice);
  const probUp = estimate5mUpProb(btcData, flow, market5m?.secondsRemaining);

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
    // Order-flow signals (same data the bot uses when making trade decisions)
    flowData: {
      obImbalance:     flow.obImbalance,
      inWindowDelta:   flow.inWindowDelta,
      liquidationBias: flow.liquidationBias,
      fundingBias:     flow.fundingBias,
      flowConfirmed:   flow.flowConfirmed,
    },
  };
}

export { getConnectionStatus };
