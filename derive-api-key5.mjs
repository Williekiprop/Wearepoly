/**
 * derive-api-key5.mjs — FIXED L1 auth
 * Fixes vs previous versions:
 *   1. nonce type is "uint256" (NOT "int256")  ← this was breaking EIP-712 hash
 *   2. HMAC output is URL-safe base64 (+→- /→_) ← this was breaking L2 sig
 *
 * Run from: artifacts/api-server
 *   node --env-file .env ../../derive-api-key5.mjs
 */

import { ethers } from "ethers";
import crypto from "crypto";

const CLOB_API = "https://clob.polymarket.com";

const pk = process.env.POLYMARKET_WALLET_KEY;
if (!pk) { console.error("POLYMARKET_WALLET_KEY not set"); process.exit(1); }
const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
const address = await wallet.getAddress();
console.log("Wallet address:", address);

const timestamp = Math.floor(Date.now() / 1000);
const nonce = 0;

const domain = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: 137,
};

// FIXED: nonce type is "uint256", NOT "int256"
const types = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
};

const value = {
  address,
  timestamp: `${timestamp}`,
  nonce,
  message: "This message attests that I control the given wallet",
};

console.log("Signing EIP-712 typed data...");
const sig = await wallet.signTypedData(domain, types, value);

// Verify locally
const recovered = ethers.verifyTypedData(domain, types, value, sig);
console.log("Local verify — recovered:", recovered);
console.log("Matches wallet:", recovered.toLowerCase() === address.toLowerCase());

const headers = {
  "POLY-ADDRESS": address,
  "POLY-SIGNATURE": sig,
  "POLY-TIMESTAMP": `${timestamp}`,
  "POLY-NONCE": `${nonce}`,
  "Content-Type": "application/json",
};

console.log("\nSending L1 auth to", CLOB_API + "/auth/api-key");
console.log("Headers:", JSON.stringify(headers, null, 2));

try {
  const res = await fetch(`${CLOB_API}/auth/api-key`, {
    method: "POST",
    headers,
  });
  const text = await res.text();
  console.log("\nStatus:", res.status);
  console.log("Body:", text);

  if (res.ok) {
    const data = JSON.parse(text);
    console.log("\n=== SUCCESS! CLOB API Credentials ===");
    console.log("POLYMARKET_API_KEY=" + data.apiKey);
    console.log("POLYMARKET_API_SECRET=" + data.secret);
    console.log("POLYMARKET_API_PASSPHRASE=" + data.passphrase);
    console.log("=====================================");
    
    // Also test the returned credentials
    console.log("\nTesting L2 auth with new credentials...");
    const ts2 = Math.floor(Date.now() / 1000);
    const rawSig = crypto.createHmac("sha256",
      Buffer.from(data.secret.replace(/-/g,"+").replace(/_/g,"/"), "base64"))
      .update(`${ts2}GET/auth/api-key`)
      .digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_"); // URL-safe
    
    const res2 = await fetch(`${CLOB_API}/auth/api-key`, {
      headers: {
        "POLY-ADDRESS": address,
        "POLY-API-KEY": data.apiKey,
        "POLY-SIGNATURE": rawSig,
        "POLY-TIMESTAMP": `${ts2}`,
        "POLY-PASSPHRASE": data.passphrase,
      }
    });
    const text2 = await res2.text();
    console.log("L2 test status:", res2.status, text2);
  }
} catch (err) {
  console.error("Request failed:", err.message);
}
