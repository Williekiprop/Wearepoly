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

app.listen(port, async () => {
  console.log(`Server listening on port ${port}`);
  // Start the Kraken WebSocket for continuous BTC price data
  startBtcWebSocket();
  // Auto-resume the bot if it was running before the server restarted
  await autoResumeBot();
});
