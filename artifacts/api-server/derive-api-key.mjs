/**
 * Derive Polymarket CLOB L2 API credentials from your wallet private key.
 * Run from artifacts/api-server:  node derive-api-key.mjs
 *
 * On success it prints the three values to paste into your .env file.
 */

import { readFileSync } from "fs";
import { ethers } from "ethers";

// Parse .env
const env = {};
for (const l of readFileSync(".env", "utf8").split("\n")) {
  const i = l.indexOf("=");
  if (i < 0) continue;
  env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const pk = env.POLYMARKET_WALLET_KEY ?? "";
if (!pk) { console.error("POLYMARKET_WALLET_KEY not set in .env"); process.exit(1); }

const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
console.log("Wallet address:", wallet.address);

// EIP-712 L1 auth message (Polymarket ClobAuth domain)
const DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: 137,
};

const TYPES = {
  ClobAuth: [
    { name: "address",   type: "address" },
    { name: "timestamp", type: "string"  },
    { name: "nonce",     type: "int256"  },
    { name: "message",   type: "string"  },
  ],
};

const NONCE = 0;
const timestamp = String(Math.floor(Date.now() / 1000));
const message   = "This message attests that I control the given wallet";

const value = {
  address:   wallet.address,
  timestamp,
  nonce:     NONCE,
  message,
};

console.log("Signing L1 auth message...");
const signature = await wallet.signTypedData(DOMAIN, TYPES, value);

const headers = {
  "Content-Type":   "application/json",
  "POLY-ADDRESS":   wallet.address,
  "POLY-SIGNATURE": signature,
  "POLY-TIMESTAMP": timestamp,
  "POLY-NONCE":     String(NONCE),
};

console.log("Requesting API credentials from Polymarket...");

const res = await fetch("https://clob.polymarket.com/auth/api-key", {
  method:  "POST",
  headers,
  signal: AbortSignal.timeout(10000),
});

const body = await res.text();
console.log("Status:", res.status);

if (!res.ok) {
  console.error("Failed:", body);
  console.log("\nIf you get a geo-block error (403/451), this must be run through the local server");
  console.log("while Proton VPN is active, not directly from this script.");
  process.exit(1);
}

let creds;
try { creds = JSON.parse(body); } catch { console.error("Non-JSON response:", body); process.exit(1); }

console.log("\n=== SUCCESS — paste these into your .env file ===");
console.log(`POLYMARKET_API_KEY=${creds.apiKey ?? creds.api_key ?? ""}`);
console.log(`POLYMARKET_API_SECRET=${creds.secret ?? creds.api_secret ?? ""}`);
console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase ?? creds.api_passphrase ?? ""}`);
console.log("=================================================\n");
console.log("Raw response:", JSON.stringify(creds, null, 2));
