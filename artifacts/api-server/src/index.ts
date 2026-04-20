import app from "./app";
import { autoResumeBot } from "./lib/botEngine.js";
import { startBtcWebSocket } from "./lib/btcPrice.js";
import { runMigrations } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, "0.0.0.0", async () => {
  console.log(`Server listening on port ${port} (0.0.0.0)`);
  const dbUrl = process.env.DATABASE_URL ?? "";
  const dbHost = dbUrl ? dbUrl.replace(/\/\/[^@]+@/, "//***@") : "(not set)";
  console.log(`[DB] Connected to: ${dbHost}`);
  // Ensure all schema columns exist before the bot tries to read/write them
  await runMigrations();
  // Start the Kraken WebSocket for continuous BTC price data
  startBtcWebSocket();
  // Auto-resume the bot if it was running before the server restarted.
  // Wrapped in try-catch so a bot startup error never prevents the server
  // (and frontend) from becoming available.
  try {
    await autoResumeBot();
  } catch (err) {
    console.error("[BOT] autoResumeBot() failed — server continues running:", err);
  }
});
