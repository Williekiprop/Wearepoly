/**
 * BTC price data via Kraken public API (no geo-restriction).
 * Provides 5-minute OHLC candles and current price.
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
  change5m: number;
  change1h: number;
  change24h: number;
  candles: BtcCandle[];
  fetchedAt: string;
}

let cache: { data: BtcPriceData; fetchedAt: number } | null = null;
const CACHE_TTL = 15_000;

export async function getBtcPriceData(): Promise<BtcPriceData> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache.data;
  }

  try {
    // Fetch ticker and OHLC in parallel from Kraken
    const [tickerRes, ohlcRes] = await Promise.all([
      fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", {
        signal: AbortSignal.timeout(8000),
      }),
      fetch("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5", {
        signal: AbortSignal.timeout(8000),
      }),
    ]);

    if (!tickerRes.ok || !ohlcRes.ok) throw new Error("Kraken API error");

    const [tickerJson, ohlcJson] = await Promise.all([
      tickerRes.json() as Promise<{
        error: string[];
        result: {
          XXBTZUSD: {
            c: [string, string]; // last trade price
            o: string;           // opening price (24h)
            h: [string, string]; // high
            l: [string, string]; // low
          };
        };
      }>,
      ohlcRes.json() as Promise<{
        error: string[];
        result: {
          XXBTZUSD: Array<[number, string, string, string, string, string, string, number]>;
          // [time, open, high, low, close, vwap, volume, count]
        };
      }>,
    ]);

    if (tickerJson.error?.length || ohlcJson.error?.length) {
      throw new Error("Kraken API returned errors");
    }

    const ticker = tickerJson.result.XXBTZUSD;
    const rawCandles = ohlcJson.result.XXBTZUSD ?? [];

    // Last element is the in-progress candle — exclude it
    const closedCandles = rawCandles.slice(0, -1);

    // Take the last 50 candles for the chart
    const last50 = closedCandles.slice(-50);

    const candles: BtcCandle[] = last50.map(([time, open, high, low, close, , volume]) => ({
      time: new Date(time * 1000).toISOString(),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    }));

    const currentPrice = parseFloat(ticker.c[0]);
    const openPrice24h = parseFloat(ticker.o);

    const change24h = openPrice24h > 0
      ? ((currentPrice - openPrice24h) / openPrice24h) * 100
      : 0;

    // 5m change: compare current vs 1 candle back
    const price5mAgo = candles.length >= 2
      ? candles[candles.length - 2].close
      : currentPrice;
    const change5m = price5mAgo > 0
      ? ((currentPrice - price5mAgo) / price5mAgo) * 100
      : 0;

    // 1h change: compare current vs 12 candles back (12 × 5min = 60min)
    const price1hAgo = candles.length >= 12
      ? candles[candles.length - 12].close
      : currentPrice;
    const change1h = price1hAgo > 0
      ? ((currentPrice - price1hAgo) / price1hAgo) * 100
      : 0;

    const data: BtcPriceData = {
      currentPrice,
      change5m,
      change1h,
      change24h,
      candles,
      fetchedAt: new Date().toISOString(),
    };

    cache = { data, fetchedAt: Date.now() };
    return data;
  } catch (err) {
    console.error("BTC price fetch error:", err);
    // Return cached stale data if available
    if (cache) return cache.data;
    // Hard fallback — no candles so chart shows nothing rather than wrong data
    return {
      currentPrice: 0,
      change5m: 0,
      change1h: 0,
      change24h: 0,
      candles: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}

/**
 * Estimate true probability for the "BTC higher" contract
 * based on recent 5m and 1h price momentum.
 *
 * - Positive 5m momentum → more likely BTC goes higher
 * - Clamped to [0.20, 0.80] to stay realistic
 */
export function estimateTrueProb(btcData: BtcPriceData): number {
  const { change5m, change1h } = btcData;
  let prob = 0.5;
  // 5m momentum dominates (short-term signal)
  prob += change5m * 0.04;
  // 1h trend provides secondary signal
  prob += change1h * 0.015;
  return Math.min(0.80, Math.max(0.20, prob));
}
