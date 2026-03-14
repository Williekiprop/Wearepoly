import { Router, type IRouter } from "express";
import { getMarketAnalysis, getConnectionStatus } from "../lib/botEngine.js";
import { getBtcPriceData } from "../lib/btcPrice.js";
import { fetchBtcMarkets } from "../lib/polymarketClient.js";

const router: IRouter = Router();

router.get("/market/analysis", async (_req, res): Promise<void> => {
  const analysis = await getMarketAnalysis();
  res.json(analysis);
});

router.get("/market/btc-price", async (_req, res): Promise<void> => {
  const data = await getBtcPriceData();
  res.json(data);
});

router.get("/market/connection", async (_req, res): Promise<void> => {
  const status = await getConnectionStatus();
  res.json(status);
});

router.get("/market/btc-markets", async (_req, res): Promise<void> => {
  const markets = await fetchBtcMarkets();
  res.json({ markets: markets.slice(0, 10) });
});

export default router;
