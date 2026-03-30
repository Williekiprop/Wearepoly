import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import botRouter from "./bot.js";
import tradesRouter from "./trades.js";
import marketRouter from "./market.js";
import authRouter from "./auth.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router: IRouter = Router();

// Public: login / logout
router.use("/auth", authRouter);

// Health check stays public (for uptime monitors / Render)
router.use(healthRouter);

// All bot, trade, and market endpoints require a valid JWT
router.use(requireAuth);
router.use(botRouter);
router.use(tradesRouter);
router.use(marketRouter);

export default router;
