/**
 * Standalone auth diagnostic — run with:
 *   node test-auth.mjs
 * from the artifacts/api-server directory (requires .env to be present)
 */

import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse .env manually
const envPath = join(__dirname, ".env");
let env = {};
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    env[k] = v;
  }
} catch (e) {
  console.error("Could not read .env:", e.message);
  process.exit(1);
}

const key        = env.POLYMARKET_API_KEY ?? "";
const secret     = env.POLYMARKET_API_SECRET ?? "";
const passphrase = env.POLYMARKET_API_PASSPHRASE ?? "";
const walletKey  = env.POLYMARKET_WALLET_KEY ?? "";

console.log("=== Credential check ===");
console.log("API key:    ", key || "NOT SET");
console.log("Secret len: ", secret.length, "(raw)");
console.log("Passphrase: ", passphrase ? `${passphrase.slice(0,3)}***` : "NOT SET");
console.log("Wallet key: ", walletKey ? `${walletKey.slice(0,6)}...` : "NOT SET");
console.log("");

// Try both decoding strategies and show decoded lengths
const stdDecoded    = Buffer.from(secret.replace(/-/g,"+").replace(/_/g,"/"), "base64");
const rawDecoded    = Buffer.from(secret);
const urlSafeDecod  = Buffer.from(secret, "base64url");

console.log("=== Secret decode lengths ===");
console.log("URL-safe-normalized base64:", stdDecoded.length, "bytes");
console.log("base64url native:          ", urlSafeDecod.length, "bytes");
console.log("raw (no decode):           ", rawDecoded.length, "bytes");
console.log("");

// Build signature using URL-safe-normalized method
const timestamp = Math.floor(Date.now() / 1000);
const method    = "GET";
const path      = "/balance-allowance?asset_type=USDC&signature_type=0";
const message   = `${timestamp}${method}${path}`;

const sig = createHmac("sha256", stdDecoded).update(message).digest("base64");

console.log("=== HMAC details ===");
console.log("Message: ", message);
console.log("Signature:", sig);
console.log("");

// Make the request
const url = `https://clob.polymarket.com${path}`;
console.log("=== Sending request to Polymarket ===");
console.log("URL:", url);

try {
  const res = await fetch(url, {
    headers: {
      "POLY-API-KEY":    key,
      "POLY-PASSPHRASE": passphrase,
      "POLY-TIMESTAMP":  String(timestamp),
      "POLY-SIGNATURE":  sig,
    },
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text);
} catch (e) {
  console.error("Request failed:", e.message);
}
