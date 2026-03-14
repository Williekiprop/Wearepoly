/**
 * Bot Engine
 * Orchestrates polling, signal generation, and trade simulation.
 * Uses real Polymarket prices in TEST mode — no real money spent.
 */

import { db, botStateTable, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { analyzeEdge } from "./lmsr.js";
import { getBtcPriceData, estimateTrueProb } from "./btcPrice.js";
import { getBestBtcMarketPrice, getConnectionStatus } from "./polymarketClient.js";

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
      lastSignal: "Bot started — connecting to Polymarket...",
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
  // Every 30s: run one cycle
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

    // Fetch BTC price data for momentum signal
    const btcData = await getBtcPriceData();

    // Try to get the real Polymarket market price
    // Falls back to 0.5 (neutral) if unavailable
    const polyData = await getBestBtcMarketPrice();

    // Our estimated true probability uses BTC momentum
    const trueProb = estimateTrueProb(btcData);

    // Use real Polymarket price as market price if available, else use LMSR neutral 0.5
    const marketYesPrice = polyData.connected ? polyData.yesPrice : 0.5;
    const marketId = polyData.market?.conditionId ?? "btc-sim-market";
    const marketTitle = polyData.market?.question ?? "Will BTC be higher? (simulated)";

    // Compute edge and Kelly sizing against the real market price
    const q: [number, number] = [0, 0];
    const analysis = analyzeEdge(
      q,
      B_PARAM,
      trueProb,
      state.balance,
      state.kellyFraction,
      state.minEdgeThreshold
    );

    // Override market price with real Polymarket price
    const edge = trueProb - marketYesPrice;
    const evPerShare = trueProb * (1 - marketYesPrice) - (1 - trueProb) * marketYesPrice;

    await db
      .update(botStateTable)
      .set({
        currentMarketPrice: marketYesPrice,
        lastSignal: Math.abs(edge) < state.minEdgeThreshold
          ? "NO_TRADE"
          : edge > 0 ? "BUY_YES" : "BUY_NO",
        lastUpdated: new Date(),
      })
      .where(eq(botStateTable.id, botId));

    if (Math.abs(edge) < state.minEdgeThreshold || state.balance < 0.5) {
      return;
    }

    if (state.mode === "test") {
      await simulateTrade(botId, state, {
        direction: edge > 0 ? "YES" : "NO",
        marketPrice: marketYesPrice,
        edge,
        evPerShare,
        kellyScaledPct: analysis.kellyScaledPct,
        positionSize: Math.min(analysis.positionSize, state.balance),
        shares: analysis.shares,
        priceImpact: analysis.priceImpact,
      }, btcData.currentPrice, marketId);
    }
  } catch (err) {
    console.error("Bot cycle error:", err);
  }
}

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
  if (positionSize <= 0 || shares <= 0) return;

  // Simulate outcome using our estimated probability
  const trueProb = direction === "YES" ? marketPrice + edge : marketPrice - edge;
  const winProb = direction === "YES" ? trueProb : 1 - trueProb;
  const won = Math.random() < winProb;

  const exitPrice = won
    ? (direction === "YES" ? 1.0 : 0.0)
    : (direction === "YES" ? 0.0 : 1.0);

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

export async function getMarketAnalysis() {
  const state = await ensureBotState();

  const [btcData, polyData] = await Promise.all([
    getBtcPriceData(),
    getBestBtcMarketPrice(),
  ]);

  const trueProb = estimateTrueProb(btcData);
  const marketYesPrice = polyData.connected ? polyData.yesPrice : 0.5;

  const q: [number, number] = [0, 0];
  const analysis = analyzeEdge(
    q,
    B_PARAM,
    trueProb,
    state.balance,
    state.kellyFraction,
    state.minEdgeThreshold
  );

  const edge = trueProb - marketYesPrice;
  const evPerShare = trueProb * (1 - marketYesPrice) - (1 - trueProb) * marketYesPrice;
  const signal = Math.abs(edge) < state.minEdgeThreshold
    ? "NO_TRADE"
    : edge > 0 ? "BUY_YES" : "BUY_NO";

  return {
    marketId: polyData.market?.conditionId ?? "btc-sim-market",
    marketTitle: polyData.market?.question ?? "Will BTC be higher? (simulated)",
    currentPrice: marketYesPrice,
    liquidityParam: B_PARAM,
    qYes: q[0],
    qNo: q[1],
    btcCurrentPrice: btcData.currentPrice,
    btcPriceChange5m: btcData.change5m,
    btcPriceChange1h: btcData.change1h,
    estimatedTrueProb: trueProb,
    edge,
    signal: signal as "BUY_YES" | "BUY_NO" | "NO_TRADE",
    evPerShare,
    recommendedDirection: edge > 0 ? "YES" : edge < 0 ? "NO" : null,
    kellySize: analysis.positionSize,
    priceImpact: analysis.priceImpact,
    analysisTime: new Date().toISOString(),
  };
}

export { getConnectionStatus };
