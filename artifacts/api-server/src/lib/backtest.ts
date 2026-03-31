/**
 * Backtest Engine — BTC 5-minute UP/DOWN strategy
 *
 * DATA SOURCES:
 *   - Polymarket Gamma API  → market resolution outcomes (who won each window)
 *   - Binance REST API      → 1-minute BTC/USDT klines for signal reconstruction
 *
 * NOTE ON ENTRY PRICE:
 *   Polymarket CLOB historical price-series for resolved 5-minute markets
 *   are not retained (returns empty []). We therefore assume entry at 50¢
 *   for both UP and DOWN tokens, which represents the maximum-lag scenario
 *   (Polymarket hasn't repriced at all by the time we enter). Real entry
 *   prices on Render will often be between 30–50¢ for the favoured side,
 *   so live edge and PnL will differ from this baseline.
 *
 * WHAT THE BACKTEST MEASURES:
 *   - Directional accuracy of the model (did we predict UP/DOWN correctly?)
 *   - Signal-strength buckets (how strong a signal do we need to be right?)
 *   - Best-case PnL at 50¢ entry
 *   - Best hours of day for directional accuracy
 */

import { estimate5mUpProb } from "./btcPrice.js";

// ── Strategy constants — simulates LATE sniper mode ──────────────────────────
// LATE mode: enter in final 40s (windowEnd - 20s = midpoint of 5–40s entry window).
// MIN_SIGNAL = 8% matches LATE mode's edge threshold (not the 19–21% EDGE threshold).
const MIN_SIGNAL = 0.08;   // model must be ≥8% edge (matches LATE mode threshold)
const LATE_ENTRY_SEC = 20; // simulate entry 20s before window end (middle of 5–40s window)

const GAMMA_API = "https://gamma-api.polymarket.com";
const KRAKEN    = "https://api.kraken.com";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BacktestTrade {
  windowStart:    number;
  windowEnd:      number;
  entryTimeUtc:   string;
  direction:      "YES" | "NO";
  entryPrice:     number;
  modelProb:      number;
  signalStrength: number;   // |probUp - 0.5|
  change1m:       number;
  change5m:       number;
  change1h:       number;
  inWindowDelta:  number;
  btcWindowMove:  number;   // % BTC moved across full 5-min window (direction signal)
  resolvedUp:     boolean;
  won:            boolean;
  pnl:            number;   // per $1 staked at 50¢ entry
  pnlPct:         number;
}

export interface BacktestStats {
  totalTrades:  number;
  wins:         number;
  losses:       number;
  winRate:      number;
  avgSignalStrength: number;
  totalPnlAt50c: number;
  roiAt50c:     number;
  profitFactor: number;
  yesTrades:    { count: number; wins: number; winRate: number };
  noTrades:     { count: number; wins: number; winRate: number };
  byHour:       Record<number, { trades: number; wins: number; winRate: number }>;
  bySignal:     Array<{ label: string; min: number; max: number; count: number; wins: number; winRate: number; avgPnl: number }>;
}

export interface BacktestResult {
  trades:          BacktestTrade[];
  stats:           BacktestStats;
  windowsScanned:  number;
  windowsResolved: number;
  windowsSkipped:  number;
  durationMs:      number;
  entryPriceNote:  string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeJson<T>(url: string, timeout = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

/**
 * Fetch 1-minute Kraken OHLC candles between startSec and endSec.
 * Kraken returns max 720 points per call, so we batch if range > 720 min.
 * Returns map of openTimeSec → closePrice.
 */
async function fetchKrakenCandles(startSec: number, endSec: number): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const BATCH_MINS = 700; // safely under 720-point limit

  let cursor = startSec;
  while (cursor < endSec) {
    const url = `${KRAKEN}/0/public/OHLC?pair=XBTUSD&interval=1&since=${cursor}`;
    const data = await safeJson<{
      error: string[];
      result: Record<string, Array<[number, string, string, string, string, string, string, number]>>;
    }>(url, 10000);

    if (!data || data.error?.length) break;

    const rows = Object.values(data.result).find(v => Array.isArray(v));
    if (!rows || rows.length === 0) break;

    let maxTime = cursor;
    for (const row of rows) {
      const t    = row[0];            // Unix seconds (open time)
      const close = parseFloat(row[4]); // close price
      if (t >= startSec && t <= endSec) {
        map.set(t, close);
      }
      if (t > maxTime) maxTime = t;
    }

    // Advance cursor to just after the last returned candle
    if (maxTime <= cursor) break;
    cursor = maxTime + 1;

    // If we got fewer than BATCH_MINS rows, we're done
    if (rows.length < BATCH_MINS) break;
  }

  return map;
}

/** Find the Kraken close price for the 1m candle whose open time (seconds) ≤ tsSec. */
function btcPriceAt(candles: Map<number, number>, tsSec: number): number | null {
  let best: number | null = null;
  let bestKey = -Infinity;
  for (const [k, v] of candles) {
    // k is Unix seconds (Kraken uses seconds, not milliseconds)
    if (k <= tsSec && k > bestKey) { bestKey = k; best = v; }
  }
  return best;
}

// ── Market metadata fetch ─────────────────────────────────────────────────────

interface MarketMeta {
  conditionId: string;
  title:       string;
  windowStart: number;
  windowEnd:   number;
  resolvedUp:  boolean;
}

async function fetchMarketBySlug(slug: string): Promise<MarketMeta | null> {
  const data = await safeJson<Array<{
    title:    string;
    slug:     string;
    endDate:  string;
    active:   boolean;
    markets:  Array<{
      conditionId:   string;
      outcomes:      string;
      outcomePrices: string;
      endDate:       string;
    }>;
  }>>(`${GAMMA_API}/events?slug=${slug}`);

  const evt = Array.isArray(data) ? data[0] : null;
  if (!evt || !evt.markets?.length) return null;

  const m = evt.markets[0];
  let outcomes: string[] = ["Up", "Down"];
  let prices:   number[] = [0.5, 0.5];
  try { outcomes = JSON.parse(m.outcomes); }      catch {}
  try { prices   = JSON.parse(m.outcomePrices).map(Number); } catch {}

  const upIdx = outcomes.findIndex(o => ["up", "yes"].includes(o.toLowerCase()));
  if (upIdx < 0) return null;

  // Only include fully resolved markets (one side = 1, other = 0)
  const resolvedUp = prices[upIdx] === 1;
  const isResolved = prices[upIdx] === 0 || prices[upIdx] === 1;
  if (!isResolved) return null;

  const windowEndTs  = Math.round(new Date(evt.endDate ?? m.endDate).getTime() / 1000);
  const slugTs       = parseInt(slug.replace("btc-updown-5m-", ""), 10);
  if (!slugTs || !windowEndTs) return null;

  return {
    conditionId: m.conditionId,
    title:       evt.title,
    windowStart: slugTs,
    windowEnd:   windowEndTs,
    resolvedUp,
  };
}

// ── Batch fetch helper ─────────────────────────────────────────────────────────

async function batchFetch<T, R>(
  items:     T[],
  fn:        (item: T) => Promise<R | null>,
  batchSize: number,
): Promise<(R | null)[]> {
  const results: (R | null)[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) {
      results.push(s.status === "fulfilled" ? s.value : null);
    }
  }
  return results;
}

// ── Main Backtest ─────────────────────────────────────────────────────────────

export async function runBacktest(
  numWindows: number = 100,
): Promise<BacktestResult> {
  const t0 = Date.now();

  const nowSec = Math.floor(Date.now() / 1000);
  const latestCompleted = Math.floor(nowSec / 300) * 300 - 300;

  // Generate slugs for the last N windows (newest first)
  const slugs: string[] = [];
  for (let i = 0; i < numWindows; i++) {
    const ws = latestCompleted - i * 300;
    slugs.push(`btc-updown-5m-${ws}`);
  }

  console.log(`[BACKTEST] Fetching ${slugs.length} market slugs...`);

  // Step 1: Fetch all market metadata in batches of 8
  const metas = await batchFetch(slugs, fetchMarketBySlug, 8);
  const resolved = metas.filter((m): m is MarketMeta => m !== null);

  console.log(`[BACKTEST] Got ${resolved.length} resolved markets out of ${slugs.length}`);

  if (resolved.length === 0) {
    return {
      trades: [], stats: emptyStats(), windowsScanned: slugs.length,
      windowsResolved: 0, windowsSkipped: slugs.length,
      durationMs: Date.now() - t0,
      entryPriceNote: "No resolved markets found.",
    };
  }

  // Step 2: Fetch Kraken OHLC candles for the full range (1h buffer before earliest window)
  const earliestWindowStart = Math.min(...resolved.map(m => m.windowStart));
  const latestWindowEnd     = Math.max(...resolved.map(m => m.windowEnd));
  const startSec = earliestWindowStart - 3700; // 1h buffer for change1h signal
  const endSec   = latestWindowEnd + 120;

  console.log(`[BACKTEST] Fetching Kraken candles from ${new Date(startSec * 1000).toISOString()} ...`);
  const allCandles = await fetchKrakenCandles(startSec, endSec);
  console.log(`[BACKTEST] Got ${allCandles.size} Kraken candles`);

  if (allCandles.size === 0) {
    return {
      trades: [], stats: emptyStats(), windowsScanned: slugs.length,
      windowsResolved: resolved.length, windowsSkipped: slugs.length - resolved.length,
      durationMs: Date.now() - t0,
      entryPriceNote: "Kraken candle data unavailable.",
    };
  }

  // Step 3: Process each window
  const trades: BacktestTrade[] = [];
  let skipped = 0;

  for (const meta of resolved) {
    const trade = processWindow(meta, allCandles);
    if (trade) trades.push(trade);
    else skipped++;
  }

  const stats = computeStats(trades);

  return {
    trades: trades.sort((a, b) => b.windowStart - a.windowStart),
    stats,
    windowsScanned:  slugs.length,
    windowsResolved: resolved.length,
    windowsSkipped:  slugs.length - resolved.length + skipped,
    durationMs: Date.now() - t0,
    entryPriceNote:
      "Simulates LATE sniper mode: signal measured at T−20s (20s before window end), held to binary resolution. " +
      "Entry price assumed = 50¢ (Polymarket CLOB history unavailable for resolved 5-min markets). " +
      "In LATE mode, actual entries are often 20–70¢ depending on how one-sided the market is — " +
      "low entry prices (e.g. 25¢ on correct side) produce +75¢ profit per dollar bet.",
  };
}

// ── Per-window processing ─────────────────────────────────────────────────────

function processWindow(meta: MarketMeta, candles: Map<number, number>): BacktestTrade | null {
  const entryTimeSec  = meta.windowEnd - LATE_ENTRY_SEC; // 20s before end (LATE mode midpoint)

  const btcEntry      = btcPriceAt(candles, entryTimeSec);
  const btc1mAgo      = btcPriceAt(candles, entryTimeSec - 60);
  const btc5mAgo      = btcPriceAt(candles, entryTimeSec - 300);
  const btc1hAgo      = btcPriceAt(candles, entryTimeSec - 3600);
  const btcWindowOpen = btcPriceAt(candles, meta.windowStart);
  const btcWindowEnd  = btcPriceAt(candles, meta.windowEnd);

  if (!btcEntry || !btc1mAgo || !btc5mAgo || !btc1hAgo || !btcWindowOpen || !btcWindowEnd) return null;

  const change1m       = ((btcEntry - btc1mAgo) / btc1mAgo) * 100;
  const change5m       = ((btcEntry - btc5mAgo) / btc5mAgo) * 100;
  const change1h       = ((btcEntry - btc1hAgo) / btc1hAgo) * 100;
  const inWindowDelta  = (btcEntry - btcWindowOpen) / btcWindowOpen;
  const btcWindowMove  = ((btcWindowEnd - btcWindowOpen) / btcWindowOpen) * 100;

  // Model estimation (OBI, liquidations, funding = 0 — not available historically)
  const btcData = { currentPrice: btcEntry, change1m, change5m, change1h, history: [] };
  const flowData = {
    obImbalance:     0,
    inWindowDelta,
    liquidationBias: 0,
    fundingBias:     0,
    flowConfirmed:   false,
  };
  const probUp = estimate5mUpProb(btcData as Parameters<typeof estimate5mUpProb>[0], flowData);
  const signalStrength = Math.abs(probUp - 0.5);

  // Only trade when model is meaningfully away from 50/50
  if (signalStrength < MIN_SIGNAL) return null;

  // Direction: follow the model
  const direction: "YES" | "NO" = probUp >= 0.5 ? "YES" : "NO";

  // Entry price assumed = 50¢ (see note in result.entryPriceNote)
  const entryPrice = 0.50;

  const won = direction === "YES" ? meta.resolvedUp : !meta.resolvedUp;
  // PnL at 50¢ entry: win = +50¢, loss = -50¢ (per $1 staked)
  const pnl = won ? 0.50 : -0.50;

  return {
    windowStart:    meta.windowStart,
    windowEnd:      meta.windowEnd,
    entryTimeUtc:   new Date(entryTimeSec * 1000).toISOString(),
    direction,
    entryPrice,
    modelProb:      probUp,
    signalStrength,
    change1m,
    change5m,
    change1h,
    inWindowDelta,
    btcWindowMove,
    resolvedUp:     meta.resolvedUp,
    won,
    pnl,
    pnlPct:         pnl * 100,
  };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function emptyStats(): BacktestStats {
  return {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    avgSignalStrength: 0, totalPnlAt50c: 0, roiAt50c: 0, profitFactor: 0,
    yesTrades: { count: 0, wins: 0, winRate: 0 },
    noTrades:  { count: 0, wins: 0, winRate: 0 },
    byHour: {}, bySignal: [],
  };
}

function computeStats(trades: BacktestTrade[]): BacktestStats {
  if (trades.length === 0) return emptyStats();

  const wins   = trades.filter(t => t.won).length;
  const losses = trades.length - wins;

  const winPnls  = trades.filter(t => t.won).map(t => t.pnl);
  const lossPnls = trades.filter(t => !t.won).map(t => t.pnl);

  const totalPnlAt50c = trades.reduce((s, t) => s + t.pnl, 0);
  const totalWin  = winPnls.reduce((a, b) => a + b, 0);
  const totalLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99.9 : 0);

  const yesTrades = trades.filter(t => t.direction === "YES");
  const noTrades  = trades.filter(t => t.direction === "NO");

  const byHour: Record<number, { trades: number; wins: number; winRate: number }> = {};
  for (const t of trades) {
    const h = new Date(t.entryTimeUtc).getUTCHours();
    if (!byHour[h]) byHour[h] = { trades: 0, wins: 0, winRate: 0 };
    byHour[h].trades++;
    if (t.won) byHour[h].wins++;
  }
  for (const h of Object.keys(byHour)) {
    const x = byHour[Number(h)];
    x.winRate = x.trades ? x.wins / x.trades : 0;
  }

  // Signal strength buckets
  const sigRanges = [
    { label: "5–10%",  min: 0.05, max: 0.10 },
    { label: "10–15%", min: 0.10, max: 0.15 },
    { label: "15–20%", min: 0.15, max: 0.20 },
    { label: "20–30%", min: 0.20, max: 0.30 },
    { label: "30–40%", min: 0.30, max: 0.40 },
    { label: "> 40%",  min: 0.40, max: 1.00 },
  ];

  const bySignal = sigRanges.map(r => {
    const bucket = trades.filter(t => t.signalStrength >= r.min && t.signalStrength < r.max);
    const bWins  = bucket.filter(t => t.won).length;
    return {
      ...r,
      count:   bucket.length,
      wins:    bWins,
      winRate: bucket.length ? bWins / bucket.length : 0,
      avgPnl:  bucket.length ? bucket.reduce((s, t) => s + t.pnl, 0) / bucket.length : 0,
    };
  }).filter(r => r.count > 0);

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: wins / trades.length,
    avgSignalStrength: trades.reduce((s, t) => s + t.signalStrength, 0) / trades.length,
    totalPnlAt50c,
    roiAt50c: (totalPnlAt50c / trades.length) * 100,
    profitFactor,
    yesTrades: {
      count:   yesTrades.length,
      wins:    yesTrades.filter(t => t.won).length,
      winRate: yesTrades.length ? yesTrades.filter(t => t.won).length / yesTrades.length : 0,
    },
    noTrades: {
      count:   noTrades.length,
      wins:    noTrades.filter(t => t.won).length,
      winRate: noTrades.length ? noTrades.filter(t => t.won).length / noTrades.length : 0,
    },
    byHour,
    bySignal,
  };
}
