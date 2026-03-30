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

// ── Resolve the frontend dist folder ─────────────────────────────────────────
// Tries several strategies so the server works regardless of CWD or how it is
// started (tsx src/index.ts, tsx src/app.ts, node dist/index.cjs, etc.)
function resolveFrontendPath(): string {
  const candidates: string[] = [];

  // 1. Explicit env override (set FRONTEND_DIST_PATH on Render if needed)
  if (process.env.FRONTEND_DIST_PATH) {
    candidates.push(process.env.FRONTEND_DIST_PATH);
  }

  // 2. Relative to this source file — works with tsx (import.meta.url is defined)
  try {
    const url = import.meta.url;
    if (url) {
      const srcDir = path.dirname(fileURLToPath(url));
      // src/app.ts  → ../../polymarket-bot/dist
      candidates.push(path.resolve(srcDir, "../../polymarket-bot/dist"));
    }
  } catch { /* CJS build — import.meta.url is undefined, skip */ }

  // 3. Relative to the entry-point script (process.argv[1]):
  //    node artifacts/api-server/dist/index.cjs  → ../../polymarket-bot/dist
  //    tsx artifacts/api-server/src/index.ts     → ../../polymarket-bot/dist
  try {
    const scriptDir = path.dirname(path.resolve(process.argv[1]));
    candidates.push(path.resolve(scriptDir, "../../polymarket-bot/dist"));
  } catch { /* ignore */ }

  // 4. Relative to CWD — covers "node dist/index.cjs" run from repo root
  //    or "cd artifacts/api-server && tsx src/..." (one level up from api-server)
  const cwd = process.cwd();
  candidates.push(path.join(cwd, "artifacts/polymarket-bot/dist")); // from repo root
  candidates.push(path.join(cwd, "../polymarket-bot/dist"));         // from inside api-server/

  // Return the first candidate that actually exists on disk
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Last resort — repo root strategy (will log "not found" but won't crash)
  return candidates[candidates.length - 1];
}

const frontendPath = resolveFrontendPath();
console.log("Serving frontend from:", frontendPath);
console.log("Dist exists?", fs.existsSync(frontendPath));
console.log("Index exists?", fs.existsSync(path.join(frontendPath, "index.html")));

// Static files
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
} else {
  console.error("❌ Frontend dist folder not found at any checked path!");
}

// Middleware
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api", router);

// SPA fallback — serve index.html for all non-API routes
app.use((req, res) => {
  const indexPath = path.join(frontendPath, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    console.error("❌ index.html NOT FOUND at", indexPath);
    res.status(500).send("Frontend not built — run: pnpm --filter @workspace/polymarket-bot run build");
  }
});

export default app;
