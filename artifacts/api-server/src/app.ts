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

  // 1. Explicit env override (set FRONTEND_DIST_PATH in Railway if needed)
  if (process.env.FRONTEND_DIST_PATH) {
    console.log("[FRONTEND] Using FRONTEND_DIST_PATH env override:", process.env.FRONTEND_DIST_PATH);
    candidates.push(process.env.FRONTEND_DIST_PATH);
  }

  // 2. Relative to this source file — works with tsx (import.meta.url is defined)
  try {
    const url = import.meta.url;
    if (url) {
      const srcDir = path.dirname(fileURLToPath(url));
      // src/app.ts  → ../../polymarket-bot/dist
      const candidate = path.resolve(srcDir, "../../polymarket-bot/dist");
      console.log("[FRONTEND] Candidate (import.meta.url):", candidate);
      candidates.push(candidate);
    }
  } catch { /* CJS build — import.meta.url is undefined, skip */ }

  // 3. Relative to the entry-point script (process.argv[1]):
  //    node artifacts/api-server/dist/index.cjs  → ../../polymarket-bot/dist
  //    tsx artifacts/api-server/src/index.ts     → ../../polymarket-bot/dist
  try {
    const scriptDir = path.dirname(path.resolve(process.argv[1]));
    const candidate = path.resolve(scriptDir, "../../polymarket-bot/dist");
    console.log("[FRONTEND] Candidate (process.argv[1] =", process.argv[1], "):", candidate);
    candidates.push(candidate);
  } catch { /* ignore */ }

  // 4. Relative to CWD — covers "node dist/index.cjs" run from repo root
  //    or "cd artifacts/api-server && tsx src/..." (one level up from api-server)
  const cwd = process.cwd();
  console.log("[FRONTEND] process.cwd():", cwd);
  const cwdCandidate1 = path.join(cwd, "artifacts/polymarket-bot/dist"); // from repo root
  const cwdCandidate2 = path.join(cwd, "../polymarket-bot/dist");         // from inside api-server/
  console.log("[FRONTEND] Candidate (cwd/artifacts/...):", cwdCandidate1);
  console.log("[FRONTEND] Candidate (cwd/../...):", cwdCandidate2);
  candidates.push(cwdCandidate1);
  candidates.push(cwdCandidate2);

  // Log existence of every candidate so we can see exactly which paths were checked
  console.log("[FRONTEND] Checking all candidates:");
  for (const p of candidates) {
    const exists = fs.existsSync(p);
    const hasIndex = exists && fs.existsSync(path.join(p, "index.html"));
    console.log(`[FRONTEND]   ${exists ? "✅" : "❌"} ${p}${hasIndex ? " (index.html ✅)" : exists ? " (index.html ❌)" : ""}`);
    if (exists) return p;
  }

  // Last resort — repo root strategy (will log "not found" but won't crash)
  console.error("[FRONTEND] ❌ No valid frontend dist found among all candidates!");
  return candidates[candidates.length - 1];
}

const frontendPath = resolveFrontendPath();
const frontendExists = fs.existsSync(frontendPath);
const indexExists = fs.existsSync(path.join(frontendPath, "index.html"));

console.log("=".repeat(60));
console.log("[FRONTEND] Resolved path :", frontendPath);
console.log("[FRONTEND] Dist exists   :", frontendExists);
console.log("[FRONTEND] index.html    :", indexExists);
console.log("=".repeat(60));

// Static files
if (frontendExists) {
  app.use(express.static(frontendPath));
} else {
  console.error("[FRONTEND] ❌ Frontend dist folder not found — static files will NOT be served!");
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
    console.error("[FRONTEND] ❌ SPA fallback triggered but index.html NOT FOUND at", indexPath);
    // Return a helpful HTML page instead of a plain-text 500 so the browser
    // renders something meaningful rather than a blank page.
    res.status(503).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Frontend Not Available</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 2rem 2.5rem; max-width: 540px; width: 100%; }
    h1 { color: #f87171; margin: 0 0 0.5rem; font-size: 1.4rem; }
    p  { color: #94a3b8; margin: 0.5rem 0; line-height: 1.6; }
    code { background: #0f172a; border: 1px solid #334155; border-radius: 4px; padding: 0.15rem 0.4rem; font-size: 0.85rem; color: #7dd3fc; }
    .path { word-break: break-all; }
    .hint { margin-top: 1.25rem; padding: 0.75rem 1rem; background: #172033; border-left: 3px solid #3b82f6; border-radius: 4px; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ Frontend build not found</h1>
    <p>The API server is running, but the compiled frontend assets could not be located.</p>
    <p class="path">Expected: <code>${indexPath}</code></p>
    <div class="hint">
      <strong>To fix:</strong> ensure the frontend is built before starting the server.<br/>
      Run: <code>pnpm --filter @workspace/polymarket-bot run build</code><br/>
      Or set the <code>FRONTEND_DIST_PATH</code> environment variable to the correct dist directory.
    </div>
    <p style="margin-top:1rem; font-size:0.8rem; color:#475569;">
      API endpoints are still available at <code>/api/*</code>
    </p>
  </div>
</body>
</html>`);
  }
});

export default app;
