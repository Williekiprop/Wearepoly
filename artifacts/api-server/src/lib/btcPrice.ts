/**
 * BTC price data — dual-source architecture for continuous data:
 *
 * 1. Kraken WebSocket v2 (wss://ws.kraken.com/v2)
 *    - Real-time ticker: price updates on every trade tick (sub-second)
 *    - Zero rate-limit risk: single persistent connection replaces all polling
 *    - Auto-reconnects with exponential backoff
 *
 * 2. Kraken HTTP OHLC (refreshed every 120s — reduced to lower rate-limit risk)
 *    - 1-minute candles for change1m / change5m / change1h calculations
 *    - OPTIONAL: if the HTTP API is unavailable, momentum is approximated from
 *      the WebSocket tick ring buffer so the bot can trade without candles.
 *
 * The in-memory cache is always fresh because the WebSocket patches the
 * current-price field on every tick, without waiting for the HTTP refresh.
 * Candle failures are non-blocking — the bot degrades gracefully to
 * WebSocket-only mode rather than halting entirely.
 */

export interface BtcCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BtcPriceData {
  currentPrice: number;
  change1m: number;
  change5m: number;
  change1h: number;
  change24h: number;
  // Short-term tick velocity — computed from the Kraken WebSocket tick ring buffer.
  // These are PERCENTAGE changes (e.g. 0.05 = +0.05%). Only populated after ~15s of WS data.
  change5s: number;   // BTC % change over the last 5 seconds
  change10s: number;  // BTC % change over the last 10 seconds
  change15s: number;  // BTC % change over the last 15 seconds
  change30s: number;  // BTC % change over the last 30 seconds
  candles: BtcCandle[];
  fetchedAt: string;
  source: "websocket" | "http";
}

// ── In-memory state ──────────────────────────────────────────────────────────

let currentPrice = 0;
let openPrice24h = 0;
let candles: BtcCandle[] = [];
let lastCandleRefresh = 0;
let candlesAvailable = false; // false until at least one successful HTTP fetch
const CANDLE_REFRESH_INTERVAL = 120_000; // refresh OHLC candles every 2 minutes (reduced to lower rate-limit risk)

// ── Short-term tick ring buffer ───────────────────────────────────────────────
// Stores timestamped BTC prices from the Kraken WebSocket for the last 60 seconds.
// This enables sub-minute velocity signals (5s/10s/15s/30s) that cannot be derived
// from 1-minute OHLC candles. The buffer is capped at 300 entries (max ~5/s × 60s).
const tickHistory: { ts: number; price: number }[] = [];
const TICK_BUFFER_MAX_MS = 60_000;

function recordTick(price: number): void {
  const now = Date.now();
  tickHistory.push({ ts: now, price });
  // Evict entries older than 60s (amortised O(1) via front-shift only when stale)
  while (tickHistory.length > 0 && now - tickHistory[0].ts > TICK_BUFFER_MAX_MS) {
    tickHistory.shift();
  }
}

/**
 * Returns the BTC price recorded closest-to-but-at-or-before `nSeconds` ago.
 * Returns null if the buffer doesn't yet have data that old.
 */
function priceNSecondsAgo(nSeconds: number): number | null {
  const cutoff = Date.now() - nSeconds * 1000;
  // Walk backwards; first entry at or before the cutoff is our target
  for (let i = tickHistory.length - 1; i >= 0; i--) {
    if (tickHistory[i].ts <= cutoff) return tickHistory[i].price;
  }
  return null; // not enough history yet
}

// Last full cache snapshot — returned instantly to callers
let latestData: BtcPriceData = {
  currentPrice: 0,
  change1m: 0,
  change5m: 0,
  change1h: 0,
  change24h: 0,
  change5s: 0,
  change10s: 0,
  change15s: 0,
  change30s: 0,
  candles: [],
  fetchedAt: new Date().toISOString(),
  source: "http",
};

// Throttle the WebSocket-only mode log to once per minute
let _lastWsOnlyLogAt = 0;

// ── Candle history HTTP refresh ──────────────────────────────────────────────

async function refreshCandles(): Promise<void> {
  try {
    const [tickerRes, ohlcRes] = await Promise.all([
      fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", {
        signal: AbortSignal.timeout(8000),
      }),
      fetch("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1", {
        signal: AbortSignal.timeout(8000),
      }),
    ]);

    if (!tickerRes.ok || !ohlcRes.ok) {
      console.error(
        `[BTC] Kraken HTTP API error — ticker: HTTP ${tickerRes.status}, OHLC: HTTP ${ohlcRes.status}` +
        ` — falling back to WebSocket-only mode`
      );
      return; // non-blocking: bot continues with WebSocket data
    }

    const [tickerJson, ohlcJson] = await Promise.all([
      tickerRes.json() as Promise<{
        error: string[];
        result: { XXBTZUSD: { c: [string, string]; o: string } };
      }>,
      ohlcRes.json() as Promise<{
        error: string[];
        result: {
          XXBTZUSD: Array<[number, string, string, string, string, string, string, number]>;
        };
      }>,
    ]);

    if (tickerJson.error?.length || ohlcJson.error?.length) {
      console.error(
        `[BTC] Kraken API returned errors — ticker: [${tickerJson.error?.join(", ")}],` +
        ` OHLC: [${ohlcJson.error?.join(", ")}] — falling back to WebSocket-only mode`
      );
      return; // non-blocking: bot continues with WebSocket data
    }

    const ticker = tickerJson.result.XXBTZUSD;
    const rawPrice = parseFloat(ticker.c[0]);
    if (rawPrice > 0) {
      openPrice24h = parseFloat(ticker.o);
      if (currentPrice === 0) currentPrice = rawPrice; // seed if WS not yet connected
    }

    const rawCandles = ohlcJson.result.XXBTZUSD ?? [];
    const closedCandles = rawCandles.slice(0, -1).slice(-29);
    const inProgressRaw = rawCandles[rawCandles.length - 1];

    candles = closedCandles.map(([time, open, high, low, close, , volume]) => ({
      time: new Date(time * 1000).toISOString(),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    }));

    if (inProgressRaw) {
      const [time, open, high, low] = inProgressRaw;
      const liveHigh = Math.max(parseFloat(high), currentPrice);
      const liveLow = Math.min(parseFloat(low), currentPrice);
      candles.push({
        time: new Date(time * 1000).toISOString(),
        open: parseFloat(open),
        high: liveHigh,
        low: liveLow,
        close: currentPrice > 0 ? currentPrice : parseFloat(inProgressRaw[4]),
        volume: parseFloat(inProgressRaw[6]),
      });
    }

    candlesAvailable = true;
    lastCandleRefresh = Date.now();
    rebuildSnapshot("http");
    console.log(`[BTC] Candles refreshed — ${candles.length} bars, latest price $${currentPrice.toFixed(2)}`);
  } catch (err) {
    // Network error, timeout, or parse failure — log and continue in WebSocket-only mode
    console.error("[BTC] Candle refresh error (non-fatal, using WebSocket-only mode):", err);
  }
}

// ── Snapshot builder — called on every WebSocket tick or candle refresh ──────

function rebuildSnapshot(source: "websocket" | "http"): void {
  // ── Momentum calculations ─────────────────────────────────────────────────
  // Primary source: OHLC candles (accurate 1-minute bars from Kraken HTTP API).
  // Fallback source: WebSocket tick ring buffer (approximated from recent ticks).
  // The tick buffer only holds 60s of history, so change1h falls back to 0 when
  // candles are unavailable — acceptable degradation vs. blocking the bot entirely.
  let price1mAgo: number;
  let price5mAgo: number;
  let price1hAgo: number;

  if (candlesAvailable && candles.length >= 2) {
    // Candles available — use accurate OHLC data
    price1mAgo = candles[candles.length - 2].close;
    price5mAgo = candles.length >= 6 ? candles[candles.length - 6].close : currentPrice;
    price1hAgo = candles[0]?.close ?? currentPrice;
  } else {
    // WebSocket-only mode — approximate from tick ring buffer
    // change1m ≈ price 60s ago; change5m ≈ price 60s ago (best we have in buffer);
    // change1h is unavailable without candles, so we leave it at 0.
    const p60s = priceNSecondsAgo(60);
    price1mAgo = p60s ?? currentPrice;
    price5mAgo = p60s ?? currentPrice; // tick buffer only holds 60s; best approximation
    price1hAgo = currentPrice;         // no 1h history without candles → change1h = 0
    if (!candlesAvailable && currentPrice > 0) {
      // Only log once per minute to avoid log spam
      const now = Date.now();
      if (now - _lastWsOnlyLogAt > 60_000) {
        console.log("[BTC] WebSocket-only mode — momentum approximated from tick buffer (candles unavailable)");
        _lastWsOnlyLogAt = now;
      }
    }
  }

  const change1m = price1mAgo > 0 ? ((currentPrice - price1mAgo) / price1mAgo) * 100 : 0;
  const change5m = price5mAgo > 0 ? ((currentPrice - price5mAgo) / price5mAgo) * 100 : 0;
  const change1h = price1hAgo > 0 && price1hAgo !== currentPrice ? ((currentPrice - price1hAgo) / price1hAgo) * 100 : 0;
  const change24h = openPrice24h > 0 ? ((currentPrice - openPrice24h) / openPrice24h) * 100 : 0;

  // Short-term velocity from the tick ring buffer
  const p5s  = priceNSecondsAgo(5);
  const p10s = priceNSecondsAgo(10);
  const p15s = priceNSecondsAgo(15);
  const p30s = priceNSecondsAgo(30);
  const pct = (old: number | null) =>
    old !== null && old > 0 ? ((currentPrice - old) / old) * 100 : 0;
  const change5s  = pct(p5s);
  const change10s = pct(p10s);
  const change15s = pct(p15s);
  const change30s = pct(p30s);

  // Patch the live in-progress candle close with the WebSocket price
  const patchedCandles = candles.length > 0
    ? [
        ...candles.slice(0, -1),
        { ...candles[candles.length - 1], close: currentPrice },
      ]
    : candles;

  latestData = {
    currentPrice,
    change1m,
    change5m,
    change1h,
    change24h,
    change5s,
    change10s,
    change15s,
    change30s,
    candles: patchedCandles,
    fetchedAt: new Date().toISOString(),
    source,
  };
}

// ── Kraken WebSocket v2 ───────────────────────────────────────────────────────

let wsConnected = false;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsInstance: WebSocket | null = null;
let wsStarted = false;
let reconnectDelayMs = 2_000;

function connectKrakenWs(): void {
  if (wsInstance) {
    try { wsInstance.close(); } catch {}
    wsInstance = null;
  }

  const ws = new WebSocket("wss://ws.kraken.com/v2");
  wsInstance = ws;

  ws.onopen = () => {
    wsConnected = true;
    reconnectDelayMs = 2_000; // reset backoff
    console.log("[BTC WS] Kraken WebSocket connected — subscribing to BTC/USD ticker");
    ws.send(JSON.stringify({
      method: "subscribe",
      params: { channel: "ticker", symbol: ["BTC/USD"] },
    }));
  };


  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as {
        channel?: string;
        type?: string;
        data?: Array<{
          symbol?: string;
          last?: number;
          open?: { today?: number; h24?: number };
          high?: { today?: number; h24?: number };
          low?: { today?: number; h24?: number };
        }>;
      };

      if (msg.channel === "ticker" && msg.data?.length) {
        const tick = msg.data[0];
        if (tick.last && tick.last > 0) {
          currentPrice = tick.last;
          if (tick.open?.today && openPrice24h === 0) openPrice24h = tick.open.today;

          // Record every tick into the short-term velocity ring buffer
          recordTick(currentPrice);

          // Throttle snapshot rebuilds to 4 per second max
          rebuildSnapshot("websocket");

          // Also refresh candles if due
          if (Date.now() - lastCandleRefresh > CANDLE_REFRESH_INTERVAL) {
            refreshCandles().catch(() => {});
          }
        }
      }
    } catch {
      // ignore malformed messages
    }
  };

  ws.onerror = () => {
    wsConnected = false;
  };

  ws.onclose = () => {
    wsConnected = false;
    wsInstance = null;
    // Exponential backoff reconnect (max 30s)
    reconnectDelayMs = Math.min(reconnectDelayMs * 1.5, 30_000);
    console.warn(`[BTC WS] Disconnected — reconnecting in ${(reconnectDelayMs / 1000).toFixed(1)}s`);
    wsReconnectTimer = setTimeout(connectKrakenWs, reconnectDelayMs);
  };
}

/** Call once at server startup. Safe to call multiple times (idempotent). */
export function startBtcWebSocket(): void {
  if (wsStarted) return;
  wsStarted = true;
  // Start WebSocket immediately — don't block on HTTP candle fetch.
  // Candles are fetched in the background; the bot trades on WebSocket data
  // from the first tick even if the Kraken HTTP API is unavailable.
  connectKrakenWs();
  refreshCandles().catch(() => {}); // background, non-blocking
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the latest BTC price data from the in-memory cache.
 * Data is continuously updated by the Kraken WebSocket — no HTTP call is made
 * unless the candle history needs a refresh (every 2 minutes).
 *
 * This function is non-blocking: it never awaits the Kraken HTTP API.
 * If candles are unavailable (API down / rate-limited), the bot operates in
 * WebSocket-only mode with momentum approximated from the tick ring buffer.
 */
export async function getBtcPriceData(): Promise<BtcPriceData> {
  // Ensure WebSocket is running — idempotent, safe to call repeatedly
  if (!wsStarted) {
    startBtcWebSocket(); // non-blocking: starts WS + background candle fetch
  }

  // If we have no price yet (WebSocket not yet connected), kick off a background
  // candle fetch to try to seed the price from HTTP — but don't await it.
  // The caller will get currentPrice=0 on the very first call if WS hasn't
  // connected yet; subsequent calls (after ~1s) will have a live price.
  if (currentPrice === 0 && !candlesAvailable) {
    refreshCandles().catch(() => {}); // background, non-blocking
  }

  // Refresh candle history if overdue (rare: only if WS didn't trigger it)
  if (lastCandleRefresh > 0 && Date.now() - lastCandleRefresh > CANDLE_REFRESH_INTERVAL + 5_000) {
    refreshCandles().catch(() => {}); // async, don't block caller
  }

  return latestData;
}

export function getBtcWsStatus(): { connected: boolean; price: number } {
  return { connected: wsConnected, price: currentPrice };
}

/**
 * Estimate true probability that BTC ends this 5-minute window HIGHER.
 *
 * ── Model architecture (time-aware) ─────────────────────────────────────────
 *
 * Two regimes based on `secondsRemaining`:
 *
 * EDGE / MID-WINDOW (> 50s remaining):
 *   Primary signal = in-window BTC delta (weight 2.0).
 *   The market has NOT yet priced in this window's BTC move — pure latency edge.
 *   Short-term velocity signals are also available but secondary.
 *
 * LATE / FINAL 50s (≤ 50s remaining):
 *   Primary signal = SHORT-TERM BTC TICK VELOCITY (5s/10s/15s).
 *   WHY: By the time we enter in the final 50s, the market has ALREADY priced in
 *   the entire in-window delta (BTC's move from 4.5 minutes ago is old news to
 *   Polymarket market-makers). Only the LAST FEW SECONDS of BTC movement is
 *   genuinely un-priced — that is our true latency edge.
 *   In-window delta is still included but heavily time-decayed.
 *
 * Shared signals (both regimes):
 *   - 1-min BTC momentum (0.40)   — recent directional pressure
 *   - Order-book imbalance (0.15) — real-time Binance bid/ask depth ratio
 *   - Liquidation bias (0.08)     — 60s rolling forced-order flow
 *   - 5-min momentum (0.05)       — medium-term trend context
 *   - 1-hour trend (0.02)         — macro context
 *   - Funding rate (0.03)         — crowded-position squeeze signal
 */
export function estimate5mUpProb(
  btcData: BtcPriceData,
  flow?: import("./orderFlow.js").OrderFlowData,
  secondsRemaining?: number
): number {
  const { change1m, change5m, change1h, change5s, change10s, change15s } = btcData;

  // Determine regime
  const isLateWindow = secondsRemaining !== undefined && secondsRemaining <= 50;

  // ── In-window delta weight: time-decayed in the late regime ─────────────────
  // At t=50s: weight = 0.80  (market has repriced ~60% of the move)
  // At t=30s: weight = 0.50  (market has repriced ~75% of the move)
  // At t=10s: weight = 0.20  (market has repriced ~90% of the move)
  // Mid-window: weight = 2.0 (market has NOT repriced yet — full latency edge)
  const inWindowWeight = isLateWindow && secondsRemaining !== undefined
    ? Math.max(0.20, secondsRemaining / 60)   // 50s→0.83, 30s→0.50, 12s→0.20
    : 2.00;

  // ── Short-term tick velocity — ONLY valid / useful in the late window ────────
  // These capture the BTC move in the last 5-15 seconds — the only slice of time
  // that Polymarket market-makers have NOT yet had a chance to price in.
  // Weights calibrated so a 0.05% BTC move in 5s → ~+10% model shift.
  //   change5s  = 0.05 → 0.05 × 2.5 = +0.125 → model = 62.5%
  //   change10s = 0.05 → 0.05 × 1.2 = +0.060 → model = 56.0% (supporting signal)
  const shortTermSignal = isLateWindow
    ? (change5s  ?? 0) * 2.50   // primary: last 5 seconds
    + (change10s ?? 0) * 1.20   // secondary: last 10 seconds
    + (change15s ?? 0) * 0.50   // tertiary: last 15 seconds
    : 0;

  const baseMomentum =
    change1m * 0.40 +
    change5m * 0.05 +
    change1h * 0.02;

  const flowSignal = flow
    ? flow.inWindowDelta  * inWindowWeight   // time-decayed in-window delta
    + flow.obImbalance   * 0.15             // live order-book pressure
    + flow.liquidationBias * 0.08           // forced liquidation direction
    + flow.fundingBias   * 0.03             // funding rate lean
    : 0;

  return Math.min(0.95, Math.max(0.05, 0.5 + baseMomentum + flowSignal + shortTermSignal));
}

/** @deprecated Use estimate5mUpProb */
export function estimateTrueProb(btcData: BtcPriceData, marketYesPrice = 0.5): number {
  const { change5m, change1h } = btcData;
  const momentumFactor = change5m * 0.05 + change1h * 0.015;
  const prob = marketYesPrice * (1 + momentumFactor);
  return Math.min(0.95, Math.max(0.005, prob));
}
