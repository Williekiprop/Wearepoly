import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import fs from "fs";
import router from "./routes";

const app = express();

// Debug crash logs
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

// Resolve __dirname in a way that works for both:
//   - ESM / tsx dev:  import.meta.url is defined → use fileURLToPath
//   - CJS prod build: import.meta.url is undefined → fall back to process.argv[1]
function resolveDirname(): string {
  try {
    // ESM path (dev with tsx)
    const url = import.meta.url;
    if (url) return path.dirname(fileURLToPath(url));
  } catch { /* fall through */ }
  // CJS path (esbuild production bundle)
  // process.argv[1] is the entry script, e.g. artifacts/api-server/dist/index.cjs
  return path.dirname(path.resolve(process.argv[1]));
}

const _dirname = resolveDirname();

// Frontend path: two levels up from src/ or dist/ → polymarket-bot/dist
const frontendPath = path.resolve(_dirname, "../../polymarket-bot/dist");
console.log("Serving frontend from:", frontendPath);
console.log("Dist exists?", fs.existsSync(frontendPath));
console.log("Index exists?", fs.existsSync(path.join(frontendPath, "index.html")));

// Static files
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
} else {
  console.error("❌ Frontend dist folder not found!");
}

// Middleware
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api", router);

// SPA fallback
app.use((req, res) => {
  const indexPath = path.join(frontendPath, "index.html");

  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(500).send("Frontend not built");
  }
});

export default app;
