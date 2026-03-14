/**
 * LMSR - Logarithmic Market Scoring Rule
 * The mathematical engine behind Polymarket's pricing.
 *
 * Core equation: C(q) = b * ln(sum(exp(qi / b)))
 * Price:         p_k(q) = exp(qk/b) / sum(exp(qi/b))   [softmax]
 */

export function lmsrCost(q: number[], b: number): number {
  const maxQ = Math.max(...q);
  const sumExp = q.reduce((acc, qi) => acc + Math.exp((qi - maxQ) / b), 0);
  return b * (Math.log(sumExp) + maxQ / b);
}

export function lmsrPrice(q: number[], b: number, outcome: number): number {
  const expQ = q.map((qi) => Math.exp(qi / b));
  const sumExp = expQ.reduce((a, b) => a + b, 0);
  return expQ[outcome] / sumExp;
}

/**
 * Expected Value per share
 * EV = true_prob * (1 - market_price) - (1 - true_prob) * market_price
 */
export function calcEV(marketPrice: number, trueProb: number): number {
  return trueProb * (1 - marketPrice) - (1 - trueProb) * marketPrice;
}

/**
 * Kelly Criterion
 * f* = (p * b_payout - q) / b_payout
 * where p = win probability, q = 1 - p, b_payout = payout multiple
 */
export function calcKelly(
  winProb: number,
  marketPrice: number
): number {
  const bPayout = (1 / marketPrice) - 1;
  if (bPayout <= 0) return 0;
  const kelly = (winProb * bPayout - (1 - winProb)) / bPayout;
  return Math.max(0, kelly);
}

/**
 * Simulate the price impact of buying `shares` shares of `outcome`
 * Returns the new price after buying
 */
export function simulatePriceImpact(
  q: number[],
  b: number,
  outcome: number,
  shares: number
): { newPrice: number; impact: number; avgFill: number } {
  const steps = 20;
  const sharesPerStep = shares / steps;
  const qCopy = [...q];
  let totalCost = 0;
  const startPrice = lmsrPrice(qCopy, b, outcome);

  for (let i = 0; i < steps; i++) {
    const qAfter = [...qCopy];
    qAfter[outcome] += sharesPerStep;
    const stepCost = lmsrCost(qAfter, b) - lmsrCost(qCopy, b);
    totalCost += stepCost;
    qCopy[outcome] += sharesPerStep;
  }

  const avgFill = shares > 0 ? totalCost / shares : startPrice;
  const newPrice = lmsrPrice(qCopy, b, outcome);
  const impact = Math.abs(newPrice - startPrice);

  return { newPrice, impact, avgFill };
}

/**
 * Full edge analyzer — given market state, your probability estimate,
 * bankroll, and kelly fraction, compute the recommended trade.
 */
export function analyzeEdge(
  q: [number, number],
  b: number,
  yourProb: number,
  bankroll: number,
  kellyFraction: number = 0.25,
  minEdge: number = 0.03
): {
  marketPrice: number;
  edge: number;
  signal: "BUY_YES" | "BUY_NO" | "NO_TRADE";
  evPerShare: number;
  kellyFullPct: number;
  kellyScaledPct: number;
  positionSize: number;
  shares: number;
  priceImpact: number;
  direction: "YES" | "NO" | null;
  impactWarning: boolean;
} {
  const marketPrice = lmsrPrice(q, b, 0);
  const edge = yourProb - marketPrice;
  const evPerShare = calcEV(marketPrice, yourProb);

  if (Math.abs(edge) < minEdge) {
    return {
      marketPrice,
      edge,
      signal: "NO_TRADE",
      evPerShare,
      kellyFullPct: 0,
      kellyScaledPct: 0,
      positionSize: 0,
      shares: 0,
      priceImpact: 0,
      direction: null,
      impactWarning: false,
    };
  }

  const isBuyYes = edge > 0;
  const entryPrice = isBuyYes ? marketPrice : 1 - marketPrice;
  const winProb = isBuyYes ? yourProb : 1 - yourProb;

  const kellyFull = calcKelly(winProb, entryPrice);
  const kellyScaled = kellyFull * kellyFraction;
  const positionSize = bankroll * kellyScaled;
  const shares = entryPrice > 0 ? positionSize / entryPrice : 0;

  const outcome = isBuyYes ? 0 : 1;
  const { impact } = simulatePriceImpact(q, b, outcome, shares);

  return {
    marketPrice,
    edge,
    signal: isBuyYes ? "BUY_YES" : "BUY_NO",
    evPerShare,
    kellyFullPct: kellyFull,
    kellyScaledPct: kellyScaled,
    positionSize,
    shares,
    priceImpact: impact,
    direction: isBuyYes ? "YES" : "NO",
    impactWarning: impact > Math.abs(edge) * 0.5,
  };
}
