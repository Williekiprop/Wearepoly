/**
 * Polymarket API Client
 * Connects to real live BTC markets on Polymarket using GAMMA + CLOB APIs.
 * API key/secret/passphrase stored in environment secrets.
 *
 * TEST MODE: reads real live prices, simulates trades — NO real money spent.
 * LIVE MODE: would place real orders (requires additional implementation).
 */

import { polyFetch } from "./proxiedFetch.js";

export interface PolymarketMarket {
  conditionId: string;
  question: string;
  outcomes: string[];
  yesPrice: number;
  noPrice: number;
  volume: number;
  active: boolean;
  slug: string;
  endDate?: string;
}

export interface PolymarketEvent {
  title: string;
  slug: string;
  volume: number;
  markets: PolymarketMarket[];
}

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

let eventCache: { events: PolymarketEvent[]; fetchedAt: number } | null = null;
const CACHE_TTL = 60_000;

/**
 * Fetch active BTC events + their nested markets from Polymarket.
 * These are real live markets with real prices.
 */
export async function fetchBtcEvents(): Promise<PolymarketEvent[]> {
  if (eventCache && Date.now() - eventCache.fetchedAt < CACHE_TTL) {
    return eventCache.events;
  }

  try {
    const res = await polyFetch(
      `${GAMMA_API}/events?active=true&limit=200&order=volume&ascending=false`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);

    const data = await res.json() as Array<{
      title: string;
      slug: string;
      volume: number;
      active: boolean;
      markets: Array<{
        conditionId: string;
        question: string;
        outcomes: string;
        outcomePrices: string;
        volume: number;
        active: boolean;
        slug: string;
        endDate?: string;
      }>;
    }>;

    const btcEvents: PolymarketEvent[] = data
      .filter((e) =>
        e.active &&
        e.title &&
        (e.title.toLowerCase().includes("bitcoin") || e.title.toLowerCase().includes("btc"))
      )
      .map((e) => ({
        title: e.title,
        slug: e.slug,
        volume: e.volume || 0,
        markets: (e.markets || [])
          .filter((m) => m.active && m.conditionId)
          .map((m) => {
            let prices: number[] = [0.5, 0.5];
            let outcomes: string[] = ["Yes", "No"];
            try {
              if (m.outcomePrices) prices = JSON.parse(m.outcomePrices).map(Number);
              if (m.outcomes) outcomes = JSON.parse(m.outcomes);
            } catch {}
            return {
              conditionId: m.conditionId,
              question: m.question,
              outcomes,
              yesPrice: prices[0] ?? 0.5,
              noPrice: prices[1] ?? 0.5,
              volume: m.volume || 0,
              active: m.active,
              slug: m.slug,
              endDate: m.endDate,
            };
          }),
      }))
      .filter((e) => e.markets.length > 0);

    eventCache = { events: btcEvents, fetchedAt: Date.now() };
    return btcEvents;
  } catch (err) {
    console.error("fetchBtcEvents error:", err);
    if (eventCache) return eventCache.events;
    return [];
  }
}

/**
 * Get ALL individual BTC markets from all events, sorted by volume.
 */
export async function fetchBtcMarkets(): Promise<PolymarketMarket[]> {
  const events = await fetchBtcEvents();
  const markets: PolymarketMarket[] = [];
  for (const e of events) {
    for (const m of e.markets) {
      if (!markets.find((x) => x.conditionId === m.conditionId)) {
        markets.push(m);
      }
    }
  }
  return markets.sort((a, b) => b.volume - a.volume);
}

/**
 * Get the best BTC market for trading:
 * - Prefer markets with prices between 0.10 and 0.90 (tradeable edge zone)
 * - Prefer higher volume markets
 * - Returns the top candidate
 */
export async function getBestBtcMarketPrice(): Promise<{
  market: PolymarketMarket | null;
  yesPrice: number;
  noPrice: number;
  connected: boolean;
}> {
  try {
    const markets = await fetchBtcMarkets();
    if (markets.length === 0) {
      return { market: null, yesPrice: 0.5, noPrice: 0.5, connected: false };
    }

    // Prefer markets in the tradeable zone (not already resolved)
    const tradeable = markets.filter(
      (m) => m.yesPrice > 0.02 && m.yesPrice < 0.98 && m.volume > 0
    );

    const best = tradeable[0] ?? markets[0];
    return {
      market: best,
      yesPrice: best.yesPrice,
      noPrice: best.noPrice,
      connected: true,
    };
  } catch {
    return { market: null, yesPrice: 0.5, noPrice: 0.5, connected: false };
  }
}

/**
 * Fetch CLOB order book for a market token ID.
 */
export async function getOrderBook(tokenId: string): Promise<{
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  bestBid: number;
  bestAsk: number;
  midPrice: number;
} | null> {
  try {
    const res = await polyFetch(`${CLOB_API}/book?token_id=${tokenId}`, {
      headers: buildAuthHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const book = await res.json() as {
      bids: { price: string; size: string }[];
      asks: { price: string; size: string }[];
    };

    const bids = book.bids ?? [];
    const asks = book.asks ?? [];
    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0.45;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0.55;

    return { bids, asks, bestBid, bestAsk, midPrice: (bestBid + bestAsk) / 2 };
  } catch {
    return null;
  }
}

function buildAuthHeaders(): Record<string, string> {
  const key = process.env.POLYMARKET_API_KEY;
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE;
  if (!key || !passphrase) return {};
  return {
    "POLY-API-KEY": key,
    "POLY-PASSPHRASE": passphrase,
    "POLY-TIMESTAMP": Math.floor(Date.now() / 1000).toString(),
    "Content-Type": "application/json",
  };
}

export function hasPolymarketCredentials(): boolean {
  return !!(
    process.env.POLYMARKET_API_KEY &&
    process.env.POLYMARKET_API_SECRET &&
    process.env.POLYMARKET_API_PASSPHRASE
  );
}

export async function getConnectionStatus(): Promise<{
  connected: boolean;
  hasCredentials: boolean;
  marketCount: number;
  topMarket: string | null;
  topMarketYesPrice: number | null;
}> {
  const hasCredentials = hasPolymarketCredentials();
  try {
    const markets = await fetchBtcMarkets();
    const best = markets.find((m) => m.yesPrice > 0.02 && m.yesPrice < 0.98);
    return {
      connected: markets.length > 0,
      hasCredentials,
      marketCount: markets.length,
      topMarket: best?.question ?? markets[0]?.question ?? null,
      topMarketYesPrice: best?.yesPrice ?? null,
    };
  } catch {
    return { connected: false, hasCredentials, marketCount: 0, topMarket: null, topMarketYesPrice: null };
  }
}
