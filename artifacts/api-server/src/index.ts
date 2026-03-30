import app from "./app";
import { autoResumeBot } from "./lib/botEngine.js";
import { startBtcWebSocket } from "./lib/btcPrice.js";

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
  // Show DB host (masked) so Render deploys can confirm the right DB is connected
  const dbUrl = process.env.DATABASE_URL ?? "";
  const dbHost = dbUrl ? dbUrl.replace(/\/\/[^@]+@/, "//***@") : "(not set)";
  console.log(`[DB] Connected to: ${dbHost}`);
  // Start the Kraken WebSocket for continuous BTC price data
  startBtcWebSocket();
  // Auto-resume the bot if it was running before the server restarted
  await autoResumeBot();
});
