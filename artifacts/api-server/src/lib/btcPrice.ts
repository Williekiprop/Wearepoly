/**
 * BTC price data via Kraken public API (no geo-restriction).
 * Uses 1-minute OHLC candles + live ticker so the chart updates every poll.
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
}

let cache: { data: BtcPriceData; fetchedAt: number } | null = null;
const CACHE_TTL = 5_000; // 5s — snappy updates in the dashboard

export async function getBtcPriceData(): Promise<BtcPriceData> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache.data;
  }

  try {
    // Fetch ticker and 1-minute OHLC in parallel from Kraken
    const [tickerRes, ohlcRes] = await Promise.all([
      fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", {
        signal: AbortSignal.timeout(8000),
      }),
      // 1-minute candles — gives a dynamic chart that adds a new bar every minute
      fetch("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1", {
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
            h: [string, string];
            l: [string, string];
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
    const currentPrice = parseFloat(ticker.c[0]);
    const rawCandles = ohlcJson.result.XXBTZUSD ?? [];

    // Take last 29 closed candles, then patch the in-progress one with the live price.
    // The last element from Kraken is the in-progress (open) candle.
    // 29 closed + 1 live = 30 candles total = ~30 min window.
    const closedCandles = rawCandles.slice(0, -1).slice(-29);
    const inProgressRaw = rawCandles[rawCandles.length - 1];

    const candles: BtcCandle[] = closedCandles.map(([time, open, high, low, close, , volume]) => ({
      time: new Date(time * 1000).toISOString(),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    }));

    // Append the live in-progress candle with current price as close
    if (inProgressRaw) {
      const [time, open, high, low] = inProgressRaw;
      const liveHigh = Math.max(parseFloat(high), currentPrice);
      const liveLow = Math.min(parseFloat(low), currentPrice);
      candles.push({
        time: new Date(time * 1000).toISOString(),
        open: parseFloat(open),
        high: liveHigh,
        low: liveLow,
        close: currentPrice, // always reflects the very latest tick
        volume: parseFloat(inProgressRaw[6]),
      });
    }

    const openPrice24h = parseFloat(ticker.o);
    const change24h = openPrice24h > 0
      ? ((currentPrice - openPrice24h) / openPrice24h) * 100
      : 0;

    // 1m change: compare current vs 1 candle back (the previous closed candle)
    const price1mAgo = candles.length >= 2
      ? candles[candles.length - 2].close
      : currentPrice;
    const change1m = price1mAgo > 0
      ? ((currentPrice - price1mAgo) / price1mAgo) * 100
      : 0;

    // 5m change: compare current vs 5 candles back (5 × 1-min = 5 min)
    const price5mAgo = candles.length >= 6
      ? candles[candles.length - 6].close
      : currentPrice;
    const change5m = price5mAgo > 0
      ? ((currentPrice - price5mAgo) / price5mAgo) * 100
      : 0;

    // 1h change: compare current vs oldest available candle (up to 60 min)
    const price1hAgo = candles[0]?.close ?? currentPrice;
    const change1h = price1hAgo > 0
      ? ((currentPrice - price1hAgo) / price1hAgo) * 100
      : 0;

    const data: BtcPriceData = {
      currentPrice,
      change1m,
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
    if (cache) return cache.data;
    return {
      currentPrice: 0,
      change1m: 0,
      change5m: 0,
      change1h: 0,
      change24h: 0,
      candles: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}

/**
 * Estimate true probability that BTC goes UP in the next 5-minute window.
 *
 * Used for the rolling btc-updown-5m markets on Polymarket.
 * Strategy: momentum blend using multiple timeframes.
 *   - Base probability is 50% (coin flip when flat)
 *   - 1m change is the PRIMARY signal — very recent momentum not yet priced in
 *     +0.1% in last minute → +3% probability shift
 *   - 5m change is a secondary trend confirmation (mild weight, already priced in)
 *     +1% over 5m → +5% probability shift
 *   - 1h change gives broader trend context
 *     +1% over 1h → +2% probability shift
 *
 * Example: BTC ticks up 0.15% in the last minute, market prices UP at 50%
 *   → model says 54.5%, market underprices UP → edge to BUY UP
 *
 * Example: BTC drops 0.2% in last minute, market prices DOWN at 50%
 *   → model says 44%, market underprices DOWN → edge to BUY DOWN
 */
export function estimate5mUpProb(btcData: BtcPriceData): number {
  const { change1m, change5m, change1h } = btcData;
  // Primary: 1m momentum — most predictive for next 5m window
  //   +0.1% BTC tick in last minute → +6% probability shift (enough to trade)
  // Secondary: 5m direction — broader trend still in play
  //   +1% over 5m → +5% shift (mild weight, partially priced in)
  // Tertiary: 1h trend — directional context
  //   +1% over 1h → +2% shift
  const momentum = change1m * 0.60 + change5m * 0.05 + change1h * 0.02;
  return Math.min(0.95, Math.max(0.05, 0.5 + momentum));
}

/**
 * @deprecated Use estimate5mUpProb for 5-minute markets.
 * Kept for backward compat with any remaining callers.
 */
export function estimateTrueProb(
  btcData: BtcPriceData,
  marketYesPrice: number = 0.5,
): number {
  const { change5m, change1h } = btcData;
  const momentumFactor = change5m * 0.05 + change1h * 0.015;
  const prob = marketYesPrice * (1 + momentumFactor);
  return Math.min(0.95, Math.max(0.005, prob));
}
