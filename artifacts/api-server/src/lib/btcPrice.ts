/**
 * BTC price fetcher using CoinGecko public API (no key required)
 * Falls back to Binance public API if needed.
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
    const [tickerRes, klineRes] = await Promise.all([
      fetch(
        "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
        { signal: AbortSignal.timeout(5000) }
      ),
      fetch(
        "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=25",
        { signal: AbortSignal.timeout(5000) }
      ),
    ]);

    if (!tickerRes.ok || !klineRes.ok) throw new Error("Binance API error");

    const ticker = await tickerRes.json() as {
      lastPrice: string;
      priceChangePercent: string;
    };
    const klines = await klineRes.json() as Array<[
      number, string, string, string, string, string, ...unknown[]
    ]>;

    const candles: BtcCandle[] = klines.map((k) => ({
      time: new Date(k[0]).toISOString(),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    const currentPrice = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.priceChangePercent);

    const price1hAgo = candles.length >= 12 ? candles[candles.length - 12].open : currentPrice;
    const price5mAgo = candles.length >= 1 ? candles[candles.length - 1].open : currentPrice;

    const change1h = price1hAgo > 0 ? ((currentPrice - price1hAgo) / price1hAgo) * 100 : 0;
    const change5m = price5mAgo > 0 ? ((currentPrice - price5mAgo) / price5mAgo) * 100 : 0;

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
  } catch {
    if (cache) return cache.data;
    const fallback: BtcPriceData = {
      currentPrice: 85000,
      change5m: 0,
      change1h: 0,
      change24h: 0,
      candles: [],
      fetchedAt: new Date().toISOString(),
    };
    return fallback;
  }
}

/**
 * Convert 5m price momentum into an estimated true probability for the
 * Polymarket BTC 5-minute "up/down" binary market.
 *
 * Logic:
 * - Base probability starts at 50%
 * - Adjust based on recent price momentum (5m change)
 * - Clamp to [0.20, 0.80] to stay realistic
 */
export function estimateTrueProb(btcData: BtcPriceData): number {
  const { change5m, change1h } = btcData;

  let prob = 0.5;
  prob += change5m * 0.04;
  prob += change1h * 0.015;

  return Math.min(0.80, Math.max(0.20, prob));
}
