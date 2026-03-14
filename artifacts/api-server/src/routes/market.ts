import { Router, type IRouter } from "express";
import { getMarketAnalysis } from "../lib/botEngine.js";
import { getBtcPriceData } from "../lib/btcPrice.js";

const router: IRouter = Router();

router.get("/market/analysis", async (_req, res): Promise<void> => {
  const analysis = await getMarketAnalysis();
  res.json(analysis);
});

router.get("/market/btc-price", async (_req, res): Promise<void> => {
  const data = await getBtcPriceData();
  res.json(data);
});

export default router;
