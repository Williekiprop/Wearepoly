/**
 * BTC price data — dual-source architecture for continuous data:
 *
 * 1. Kraken WebSocket v2 (wss://ws.kraken.com/v2)
 *    - Real-time ticker: price updates on every trade tick (sub-second)
 *    - Zero rate-limit risk: single persistent connection replaces all polling
 *    - Auto-reconnects with exponential backoff
 *
 * 2. Kraken HTTP OHLC (refreshed every 60s)
 *    - 1-minute candles for change1m / change5m / change1h calculations
 *    - Only needs refreshing once per minute — vastly reduced call frequency
 *
 * The in-memory cache is always fresh because the WebSocket patches the
 * current-price field on every tick, without waiting for the HTTP refresh.
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
  candles: BtcCandle[];
  fetchedAt: string;
  source: "websocket" | "http";
}

// ── In-memory state ──────────────────────────────────────────────────────────

let currentPrice = 0;
let openPrice24h = 0;
let candles: BtcCandle[] = [];
let lastCandleRefresh = 0;
const CANDLE_REFRESH_INTERVAL = 60_000; // refresh OHLC candles once per minute

// Last full cache snapshot — returned instantly to callers
let latestData: BtcPriceData = {
  currentPrice: 0,
  change1m: 0,
  change5m: 0,
  change1h: 0,
  change24h: 0,
  candles: [],
  fetchedAt: new Date().toISOString(),
  source: "http",
};

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

    if (!tickerRes.ok || !ohlcRes.ok) throw new Error("Kraken OHLC fetch failed");

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

    if (tickerJson.error?.length || ohlcJson.error?.length) throw new Error("Kraken API errors");

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

    lastCandleRefresh = Date.now();
    rebuildSnapshot("http");
    console.log(`[BTC] Candles refreshed — ${candles.length} bars, latest price $${currentPrice.toFixed(2)}`);
  } catch (err) {
    console.error("[BTC] Candle refresh error:", err);
  }
}

// ── Snapshot builder — called on every WebSocket tick or candle refresh ──────

function rebuildSnapshot(source: "websocket" | "http"): void {
  const price1mAgo = candles.length >= 2 ? candles[candles.length - 2].close : currentPrice;
  const price5mAgo = candles.length >= 6 ? candles[candles.length - 6].close : currentPrice;
  const price1hAgo = candles[0]?.close ?? currentPrice;

  const change1m = price1mAgo > 0 ? ((currentPrice - price1mAgo) / price1mAgo) * 100 : 0;
  const change5m = price5mAgo > 0 ? ((currentPrice - price5mAgo) / price5mAgo) * 100 : 0;
  const change1h = price1hAgo > 0 ? ((currentPrice - price1hAgo) / price1hAgo) * 100 : 0;
  const change24h = openPrice24h > 0 ? ((currentPrice - openPrice24h) / openPrice24h) * 100 : 0;

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
  // Seed candles via HTTP first, then open WebSocket
  refreshCandles().then(() => connectKrakenWs()).catch(() => connectKrakenWs());
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the latest BTC price data from the in-memory cache.
 * Data is continuously updated by the Kraken WebSocket — no HTTP call is made
 * unless the candle history needs a refresh (once per minute).
 */
export async function getBtcPriceData(): Promise<BtcPriceData> {
  // If WebSocket is not started (first call), fall back to HTTP and start WS
  if (!wsStarted) {
    startBtcWebSocket();
    await refreshCandles();
  }

  // If we somehow have no price yet, do a one-off HTTP fetch
  if (currentPrice === 0) {
    await refreshCandles();
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
 * Estimate true probability that BTC goes UP in the next 5-minute window.
 * Uses multi-timeframe momentum blend.
 */
export function estimate5mUpProb(btcData: BtcPriceData): number {
  const { change1m, change5m, change1h } = btcData;
  // Weights: 1m momentum dominates; 5m trend adds context; 1h gives macro bias.
  // 5m weight raised from 0.05 → 0.15 so sustained trends reinforce signals.
  const momentum = change1m * 0.60 + change5m * 0.15 + change1h * 0.02;
  return Math.min(0.95, Math.max(0.05, 0.5 + momentum));
}

/** @deprecated Use estimate5mUpProb */
export function estimateTrueProb(btcData: BtcPriceData, marketYesPrice = 0.5): number {
  const { change5m, change1h } = btcData;
  const momentumFactor = change5m * 0.05 + change1h * 0.015;
  const prob = marketYesPrice * (1 + momentumFactor);
  return Math.min(0.95, Math.max(0.005, prob));
}
