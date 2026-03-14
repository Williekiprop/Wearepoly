/**
 * Bot Engine
 * Orchestrates polling, signal generation, and trade simulation.
 */

import { db, botStateTable, tradesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { analyzeEdge } from "./lmsr.js";
import { getBtcPriceData, estimateTrueProb } from "./btcPrice.js";

const POLYMARKET_BTC_5M_MARKET_ID = "btc-5m-test-market";
const POLYMARKET_BTC_5M_MARKET_TITLE = "Will BTC be higher in 5 minutes?";
const B_PARAM = 100;

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
  const state = await ensureBotState();

  await db
    .update(botStateTable)
    .set({
      running: true,
      mode: opts.mode,
      balance: opts.startingBalance,
      startingBalance: opts.startingBalance,
      totalPnl: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      currentPosition: undefined,
      currentMarketPrice: undefined,
      lastSignal: "Bot started",
      kellyFraction: opts.kellyFraction ?? 0.25,
      minEdgeThreshold: opts.minEdgeThreshold ?? 0.03,
      lastUpdated: new Date(),
    })
    .where(eq(botStateTable.id, state.id));

  startPolling(state.id);
  return getBotState();
}

export async function stopBot() {
  const state = await ensureBotState();
  stopPolling();

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
      lastSignal: "Bot reset",
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

    const btcData = await getBtcPriceData();
    const trueProb = estimateTrueProb(btcData);

    const qYes = 0;
    const qNo = 0;
    const q: [number, number] = [qYes, qNo];

    const analysis = analyzeEdge(
      q,
      B_PARAM,
      trueProb,
      state.balance,
      state.kellyFraction,
      state.minEdgeThreshold
    );

    await db
      .update(botStateTable)
      .set({
        currentMarketPrice: analysis.marketPrice,
        lastSignal: analysis.signal,
        lastUpdated: new Date(),
      })
      .where(eq(botStateTable.id, botId));

    if (analysis.signal === "NO_TRADE" || analysis.positionSize <= 0 || state.balance < 0.5) {
      return;
    }

    if (state.mode === "test") {
      await simulateTrade(botId, state, analysis, btcData.currentPrice, q);
    }
  } catch (err) {
    console.error("Bot cycle error:", err);
  }
}

async function simulateTrade(
  botId: number,
  state: { id: number; balance: number; totalTrades: number; winningTrades: number; losingTrades: number; totalPnl: number; kellyFraction: number; minEdgeThreshold: number },
  analysis: ReturnType<typeof analyzeEdge>,
  btcPrice: number,
  _q: [number, number]
) {
  const positionSize = Math.min(analysis.positionSize, state.balance);
  if (positionSize <= 0) return;

  const trueProb = analysis.direction === "YES" ? analysis.marketPrice + analysis.edge : analysis.marketPrice - analysis.edge;
  const winProb = analysis.direction === "YES" ? trueProb : 1 - trueProb;
  const won = Math.random() < winProb;

  const exitPrice = won
    ? (analysis.direction === "YES" ? 1.0 : 0.0)
    : (analysis.direction === "YES" ? 0.0 : 1.0);

  const entryPrice = analysis.direction === "YES" ? analysis.marketPrice : 1 - analysis.marketPrice;
  const pnl = analysis.shares * (exitPrice - entryPrice);

  const newBalance = state.balance + pnl;
  const newTotalTrades = state.totalTrades + 1;
  const newWinning = won ? state.winningTrades + 1 : state.winningTrades;
  const newLosing = won ? state.losingTrades : state.losingTrades + 1;
  const newTotalPnl = state.totalPnl + pnl;

  await db.insert(tradesTable).values({
    direction: analysis.direction!,
    marketPrice: analysis.marketPrice,
    estimatedProb: trueProb,
    edge: analysis.edge,
    kellyFraction: analysis.kellyScaledPct,
    positionSize,
    shares: analysis.shares,
    priceImpact: analysis.priceImpact,
    exitPrice,
    pnl,
    status: "closed",
    btcPriceAtEntry: btcPrice,
    marketId: POLYMARKET_BTC_5M_MARKET_ID,
    mode: "test",
    resolvedAt: new Date(),
  });

  await db
    .update(botStateTable)
    .set({
      balance: newBalance,
      totalTrades: newTotalTrades,
      winningTrades: newWinning,
      losingTrades: newLosing,
      totalPnl: newTotalPnl,
      lastUpdated: new Date(),
    })
    .where(eq(botStateTable.id, botId));
}

export async function getMarketAnalysis() {
  const state = await ensureBotState();
  const btcData = await getBtcPriceData();
  const trueProb = estimateTrueProb(btcData);

  const q: [number, number] = [0, 0];
  const analysis = analyzeEdge(
    q,
    B_PARAM,
    trueProb,
    state.balance,
    state.kellyFraction,
    state.minEdgeThreshold
  );

  return {
    marketId: POLYMARKET_BTC_5M_MARKET_ID,
    marketTitle: POLYMARKET_BTC_5M_MARKET_TITLE,
    currentPrice: analysis.marketPrice,
    liquidityParam: B_PARAM,
    qYes: q[0],
    qNo: q[1],
    btcCurrentPrice: btcData.currentPrice,
    btcPriceChange5m: btcData.change5m,
    btcPriceChange1h: btcData.change1h,
    estimatedTrueProb: trueProb,
    edge: analysis.edge,
    signal: analysis.signal,
    evPerShare: analysis.evPerShare,
    recommendedDirection: analysis.direction,
    kellySize: analysis.positionSize,
    priceImpact: analysis.priceImpact,
    analysisTime: new Date().toISOString(),
  };
}
