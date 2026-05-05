/**
 * Order-flow signals for front-running Polymarket 5-minute markets.
 *
 * The edge: Polymarket CLOB prices lag Binance by 1–10 seconds when BTC moves
 * sharply. These signals detect that movement as it happens and let the bot
 * snipe the mispriced token before the market catches up.
 *
 * Three independent sources:
 *
 * 1. Binance spot depth5@500ms — real-time order-book imbalance.
 *    (totalBidVol - totalAskVol) / (totalBidVol + totalAskVol) in top 5 levels.
 *    Range: -1 (all asks, heavy sell) → +1 (all bids, heavy buy).
 *    Update: every 500ms from WebSocket.
 *
 * 2. Binance USDT-M futures forceOrder — liquidation bursts.
 *    BUY liquidations = shorts being squeezed → bullish.
 *    SELL liquidations = longs being stopped → bearish.
 *    Rolling 60s USD-weighted score, range -1 → +1.
 *
 * 3. Binance futures fundingRate — crowded-position signal.
 *    Positive funding (longs pay shorts) → mild bearish bias (overextended longs).
 *    Negative funding (shorts pay longs) → mild bullish bias (short-squeeze risk).
 *    Updated every 5 minutes via REST.
 *
 * 4. In-window BTC delta — how much has BTC moved since THIS 5-min window opened.
 *    This is the core front-running signal: if BTC moved +0.3% and Polymarket
 *    still shows UP at 45¢, the window is mispriced and should be sniped.
 *    Tracked in-process by watching window boundary transitions.
 */

export interface OrderFlowData {
  obImbalance: number;      // -1 to +1: order-book bid/ask pressure
  liquidationBias: number;  // -1 to +1: rolling 60s liquidation flow
  fundingBias: number;      // -1 to +1: funding rate directional signal
  inWindowDelta: number;    // % BTC change since window opened (e.g. +0.25 = +0.25%)
  flowConfirmed: boolean;   // true if signals strongly agree on direction (|OBI| > 0.35 OR |delta| > 0.15%)
}

// ── Internal state ────────────────────────────────────────────────────────────

let _obImbalance = 0;
let _fundingBias = 0;
let _windowOpenPrice = 0;
let _lastWindowEnd = "";

const _liqEvents: { usdSize: number; side: "BUY" | "SELL"; ts: number }[] = [];

let _started = false;
let _fundingRefreshedAt = 0;

// ── 1. Order-book imbalance — Binance spot depth WebSocket ────────────────────

function connectDepthWs(): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@depth5@500ms");
  } catch {
    setTimeout(connectDepthWs, 5_000);
    return;
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as {
        bids: [string, string][];
        asks: [string, string][];
      };
      const bidVol = msg.bids.reduce((s, [, q]) => s + parseFloat(q), 0);
      const askVol = msg.asks.reduce((s, [, q]) => s + parseFloat(q), 0);
      const total = bidVol + askVol;
      _obImbalance = total > 0 ? (bidVol - askVol) / total : 0;
    } catch { /* ignore malformed */ }
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onclose = () => {
    setTimeout(connectDepthWs, 3_000);
  };
}

// ── 2. Liquidation bursts — Binance USDT-M futures forceOrder stream ──────────

function connectLiqWs(): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket("wss://fstream.binance.com/ws/btcusdt@forceOrder");
  } catch {
    setTimeout(connectLiqWs, 5_000);
    return;
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as {
        o?: { s?: string; S?: string; q?: string; ap?: string };
      };
      const o = msg.o;
      if (!o || o.s !== "BTCUSDT") return;

      const qty = parseFloat(o.q ?? "0");
      const price = parseFloat(o.ap ?? "0");
      const usdSize = qty * price;
      if (usdSize < 10_000) return; // ignore tiny liquidations

      _liqEvents.push({ usdSize, side: o.S as "BUY" | "SELL", ts: Date.now() });
      console.log(`[FLOW] Liquidation: ${o.S} $${(usdSize / 1000).toFixed(0)}k BTC`);
    } catch { /* ignore */ }
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onclose = () => setTimeout(connectLiqWs, 3_000);
}

function computeLiqBias(): number {
  const cutoff = Date.now() - 60_000;
  // Prune old events
  let i = 0;
  while (i < _liqEvents.length && _liqEvents[i].ts < cutoff) i++;
  if (i > 0) _liqEvents.splice(0, i);

  if (_liqEvents.length === 0) return 0;

  let bullUsd = 0; // BUY liquidations = shorts squeezed → UP
  let bearUsd = 0; // SELL liquidations = longs stopped → DOWN
  for (const e of _liqEvents) {
    if (e.side === "BUY") bullUsd += e.usdSize;
    else bearUsd += e.usdSize;
  }
  const total = bullUsd + bearUsd;
  return total > 0 ? (bullUsd - bearUsd) / total : 0;
}

// ── 3. Funding rate — Binance USDT-M futures REST ─────────────────────────────

async function refreshFunding(): Promise<void> {
  try {
    const resp = await fetch(
      "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1",
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!resp.ok) return;
    const data = await resp.json() as Array<{ fundingRate: string }>;
    const rate = parseFloat(data[0]?.fundingRate ?? "0");
    // Typical range: -0.001 to +0.001 (±0.1%)
    // Positive funding (longs heavy) → bearish lean (overextension)
    // Negative funding (shorts heavy) → bullish lean (squeeze risk)
    _fundingBias = Math.max(-1, Math.min(1, rate * -500));
    _fundingRefreshedAt = Date.now();
    console.log(`[FLOW] Funding rate: ${(rate * 100).toFixed(4)}% → bias ${_fundingBias.toFixed(2)}`);
  } catch {
    // Non-fatal — funding bias stays at last known value
  }
}

// ── 4. In-window BTC delta tracking ──────────────────────────────────────────

/**
 * Call once per bot cycle with the current window's end timestamp and live BTC price.
 * Detects window transitions and records the BTC price at window open.
 */
export function updateWindowOpen(windowEnd: string, currentBtcPrice: number): void {
  if (windowEnd !== _lastWindowEnd) {
    // New 5-min window started — snapshot the opening BTC price
    _lastWindowEnd = windowEnd;
    _windowOpenPrice = currentBtcPrice;
  }
}

function getInWindowDelta(currentBtcPrice: number): number {
  if (_windowOpenPrice <= 0 || currentBtcPrice <= 0) return 0;
  return ((currentBtcPrice - _windowOpenPrice) / _windowOpenPrice) * 100;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start all order-flow feeds. Safe to call multiple times (idempotent). */
export function startOrderFlow(): void {
  if (_started) return;
  _started = true;

  connectDepthWs();
  connectLiqWs();

  // Initial funding rate fetch + 5-min refresh
  refreshFunding().catch(() => {});
  setInterval(() => {
    if (Date.now() - _fundingRefreshedAt > 4.5 * 60_000) {
      refreshFunding().catch(() => {});
    }
  }, 5 * 60_000);

  console.log("[FLOW] Order-flow feeds started (depth, liquidations, funding)");
}

// ── Order-flow result cache ───────────────────────────────────────────────────
// getOrderFlowData is called every bot cycle (every 3s). The underlying signals
// update on their own schedules (OBI: 500ms WS, liquidations: event-driven,
// funding: 5min REST). Caching for 2s avoids redundant computeLiqBias() work
// and keeps the result consistent within a single cycle even if called twice.
const ORDER_FLOW_CACHE_TTL = 2_000; // ms
let _cachedFlow: OrderFlowData | null = null;
let _cachedFlowTs = 0;
let _cachedFlowBtcPrice = 0;

/** Returns the latest order-flow snapshot for use in signal calculations. */
export function getOrderFlowData(currentBtcPrice: number): OrderFlowData {
  const now = Date.now();
  // Serve from cache if still fresh AND BTC price hasn't changed meaningfully
  if (
    _cachedFlow !== null &&
    now - _cachedFlowTs < ORDER_FLOW_CACHE_TTL &&
    Math.abs(currentBtcPrice - _cachedFlowBtcPrice) < 1 // < $1 BTC move
  ) {
    return _cachedFlow;
  }

  const obImbalance = _obImbalance;
  const liquidationBias = computeLiqBias();
  const fundingBias = _fundingBias;
  const inWindowDelta = getInWindowDelta(currentBtcPrice);

  // "Flow confirmed" = at least one signal strongly agrees on direction.
  // Used to relax the edge cap for legitimate front-running entries.
  const flowConfirmed =
    Math.abs(obImbalance) > 0.35 ||
    Math.abs(inWindowDelta) > 0.15 ||
    Math.abs(liquidationBias) > 0.5;

  const result: OrderFlowData = { obImbalance, liquidationBias, fundingBias, inWindowDelta, flowConfirmed };
  _cachedFlow = result;
  _cachedFlowTs = now;
  _cachedFlowBtcPrice = currentBtcPrice;
  return result;
}
