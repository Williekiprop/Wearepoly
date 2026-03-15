/**
 * Polymarket Real Order Placement
 *
 * Uses the Polymarket CLOB API with:
 * 1. EIP-712 typed data signing (ethers v6) for order authorization
 * 2. HMAC-SHA256 request signing for API authentication
 *
 * Docs: https://docs.polymarket.com/#api
 */

import { ethers } from "ethers";
import * as crypto from "crypto";
import { polyFetch, hasProxy } from "./proxiedFetch.js";

const CLOB_API = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

// EIP-712 domain for Polymarket CTF Exchange
// IMPORTANT: "Polymarket CTF Exchange" is the exact domain name required.
// Using "CTFExchange" produces a different hash and causes 400 Invalid order payload.
const DOMAIN = {
  name: "Polymarket CTF Exchange",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
};

// Gnosis Safe CompatibilityFallbackHandler wraps hashes before isValidSignature
// SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes message)")
const SAFE_MSG_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("SafeMessage(bytes message)"));

// Polygon RPC for on-chain reads (domain separator)
const POLYGON_RPC_PRIMARY = "https://polygon-bor-rpc.publicnode.com";

// EIP-712 Order type
const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
};

export interface PlaceOrderParams {
  tokenId: string;       // CLOB token ID for the YES or NO outcome
  side: "BUY" | "SELL";
  price: number;         // 0.0 to 1.0
  sizeUsdc: number;      // USDC amount to spend
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  errorMessage?: string;
  transactionHash?: string;
}

/** A fully signed + authenticated order payload ready for the browser to POST directly to Polymarket. */
export interface PreparedBrowserOrder {
  id: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  meta: { direction: string; price: number; sizeUsdc: number };
}

function getWallet(): ethers.Wallet {
  const pk = process.env.POLYMARKET_WALLET_KEY;
  if (!pk) throw new Error("POLYMARKET_WALLET_KEY not set");
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  return new ethers.Wallet(key);
}

/**
 * For signatureType=2 (POLY_GNOSIS_SAFE):
 * Gnosis Safe's CompatibilityFallbackHandler wraps the order hash inside a
 * SafeMessage envelope before calling isValidSignature. We must sign the
 * Safe-wrapped hash (not the raw EIP-712 order hash) with the EOA private key.
 *
 * Wrapping formula:
 *   msgHash = keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(orderHash))))
 *   finalHash = keccak256("\x19\x01" + safe.domainSeparator() + msgHash)
 *
 * The EOA signs finalHash raw (no prefix), and the Safe validates via:
 *   ecrecover(finalHash, v, r, s) == EOA == owner
 */
async function buildSafeWrappedSignature(
  orderHash: string,
  safeAddress: string,
  privateKey: string
): Promise<string> {
  // Fetch the Safe's domain separator from chain
  const domainSepCalldata =
    "0xf698da25"; // keccak256("domainSeparator()").slice(0,8)
  const rpcBody = JSON.stringify({
    jsonrpc: "2.0", method: "eth_call",
    params: [{ to: safeAddress, data: domainSepCalldata }, "latest"],
    id: 1,
  });
  const rpcRes = await fetch(POLYGON_RPC_PRIMARY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rpcBody,
    signal: AbortSignal.timeout(8000),
  });
  const rpcJson = await rpcRes.json() as { result: string };
  const domainSeparator = rpcJson.result as string;

  // Compute the Safe-wrapped message hash
  const encodedOrderHash = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [orderHash]);
  const msgHash = ethers.keccak256(encodedOrderHash);
  const safeMessageHashInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32"],
    [SAFE_MSG_TYPEHASH, msgHash]
  );
  const safeMessageHash = ethers.keccak256(safeMessageHashInput);

  // Final hash: EIP-191 prefix + domain separator + safeMessageHash
  const finalHash = ethers.keccak256(
    ethers.concat([
      new Uint8Array([0x19, 0x01]),
      ethers.getBytes(domainSeparator),
      ethers.getBytes(safeMessageHash),
    ])
  );

  // Sign the final hash directly with the EOA's signing key
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const signingKey = new ethers.SigningKey(key);
  const sig = signingKey.sign(finalHash);
  const serialized = ethers.Signature.from(sig).serialized;

  console.log(`[ORDER] Safe-wrapped hash: ${finalHash} | sig: ${serialized.slice(0, 12)}...`);
  return serialized;
}

/**
 * Returns the proxy wallet address (Gnosis Safe created by Polymarket).
 * If POLYMARKET_PROXY_ADDRESS is set, uses it (signatureType=2 POLY_GNOSIS_SAFE).
 * Otherwise falls back to the EOA address (signatureType=0).
 */
function getProxyAddress(): string | null {
  return process.env.POLYMARKET_PROXY_ADDRESS ?? null;
}

function getSignatureType(): 0 | 2 {
  return process.env.POLYMARKET_PROXY_ADDRESS ? 2 : 0;
}

function buildHmacSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: number,
  body: string = ""
): string {
  const message = `${timestamp}${method}${path}${body}`;
  const normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
  const secretBuffer = Buffer.from(normalized, "base64");
  const sig = crypto.createHmac("sha256", secretBuffer).update(message).digest("base64");
  // Polymarket requires URL-safe base64 output for POLY_SIGNATURE
  return sig.replace(/\+/g, "-").replace(/\//g, "_");
}

async function buildApiHeaders(
  method: string,
  path: string,
  body: string = ""
): Promise<Record<string, string>> {
  const key = process.env.POLYMARKET_API_KEY ?? "";
  const secret = process.env.POLYMARKET_API_SECRET ?? "";
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE ?? "";
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = buildHmacSignature(secret, method, path, timestamp, body);

  const wallet = getWallet();
  const address = await wallet.getAddress();

  return {
    "Content-Type": "application/json",
    "POLY_ADDRESS": address,
    "POLY_API_KEY": key,
    "POLY_PASSPHRASE": passphrase,
    "POLY_TIMESTAMP": String(timestamp),
    "POLY_SIGNATURE": signature,
  };
}

/**
 * Build and sign a Polymarket limit order using EIP-712.
 * Returns the signed order payload ready to POST to /order.
 *
 * When POLYMARKET_PROXY_ADDRESS is set (POLY_GNOSIS_SAFE mode):
 *   maker  = proxy wallet  (Gnosis Safe — holds USDC, receives tokens)
 *   signer = proxy wallet  (Gnosis Safe validates via EIP-1271 isValidSignature)
 *   signatureType = 2      (POLY_GNOSIS_SAFE)
 *   The EOA (Safe owner, threshold=1) signs the Safe-wrapped message hash:
 *   CTFExchange calls proxy.isValidSignature(orderHash, sig) →
 *   CompatibilityFallbackHandler wraps hash → EOA sig must be over finalHash.
 *
 * Without proxy (EOA mode):
 *   maker = signer = EOA, signatureType = 0
 */
async function buildSignedOrder(
  params: PlaceOrderParams,
  wallet: ethers.Wallet
): Promise<object> {
  const { tokenId, side, sizeUsdc } = params;
  const eoaAddress = await wallet.getAddress();
  const proxyAddress = getProxyAddress();
  const sigType = getSignatureType();
  // For signatureType=2 (POLY_GNOSIS_SAFE):
  //   maker  = proxy (Gnosis Safe — holds USDC and tokens)
  //   signer = EOA  (the Safe owner that signs the EIP-712 hash)
  //   The CLOB validates off-chain: ecrecover(orderHash, sig) == order.signer == EOA
  // For signatureType=0 (EOA): maker = signer = EOA
  const makerAddress = proxyAddress ?? eoaAddress;
  const signerAddress = eoaAddress; // always EOA regardless of mode

  // Polymarket requires prices in 0.001 increments (3 decimal places / 1000 ticks).
  // Snap to nearest tick to avoid "Invalid order payload" rejections.
  const price = Math.round(params.price * 1000) / 1000;
  if (price <= 0 || price >= 1) throw new Error(`Price out of range after tick snap: ${price}`);
  if (price !== params.price) {
    console.log(`[ORDER] Price snapped ${params.price} → ${price} (tick grid 0.001)`);
  }

  // Polymarket CLOB amount precision rules (BUY side):
  //   takerAmount (tokens out): max 2 decimal places in token denomination
  //     → must be divisible by 10,000 micro-tokens (since 1 token = 1e6 micro-tokens)
  //   makerAmount (USDC in): MUST equal round(price × takerAmount_in_tokens, 5 dp)
  //     → CLOB independently validates: makerAmount == price × takerAmount
  //
  // Derivation order: takerAmount first → makerAmount derived from it.

  // Step 1: tokens to receive, rounded UP to 2 decimal places in token denomination
  const takerTokens = Math.ceil((sizeUsdc / price) * 100) / 100; // e.g., 21.74
  const takerAmount = Math.round(takerTokens * 1e6); // micro-tokens, divisible by 10,000

  // Step 2: USDC to spend = price × takerTokens, rounded to 5 decimal places
  // CLOB validates this formula, so we must match it exactly.
  const makerUsdc = Math.round(price * takerTokens * 1e5) / 1e5; // e.g., 1.00004
  const makerAmount = Math.round(makerUsdc * 1e6); // micro-USDC, divisible by 10

  const salt = BigInt(Math.floor(Math.random() * 1e15));
  // GTC orders MUST have expiration = 0 (only GTD orders use a timestamp).
  // CLOB explicitly rejects any non-zero expiration on GTC orders.
  const expiration = BigInt(0);
  const sideInt = side === "BUY" ? 0 : 1;

  const orderData = {
    salt: salt,
    maker: makerAddress,    // proxy (Gnosis Safe) or EOA
    signer: signerAddress,  // EOA — CLOB validates off-chain via ecrecover
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: BigInt(tokenId),
    makerAmount: BigInt(makerAmount),
    takerAmount: BigInt(takerAmount),
    expiration: expiration,
    nonce: BigInt(0),
    feeRateBps: BigInt(0),
    side: sideInt,
    signatureType: sigType,
  };

  // EOA signs the EIP-712 order hash directly using standard signTypedData.
  // For signatureType=2 (POLY_GNOSIS_SAFE), the CLOB validates off-chain as:
  //   ecrecover(orderHash, sig) == proxy.owner (EOA)
  // This is identical to signatureType=0; the CLOB knows the proxy<>EOA relationship.
  const signature = await wallet.signTypedData(DOMAIN, ORDER_TYPES, orderData);

  console.log(`[ORDER] signatureType=${sigType} maker=${makerAddress} signer=${signerAddress} eoaSigner=${eoaAddress}`);

  // NOTE: salt must be a JSON integer (not string) to match the CLOB's schema validation.
  // All other uint256 fields (makerAmount, takerAmount, expiration, nonce, feeRateBps)
  // are strings. This matches the official @polymarket/clob-client's orderToJson() format.
  return {
    salt: Number(salt),           // integer, not string (schema validation requirement)
    maker: makerAddress,
    signer: signerAddress,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: tokenId,
    makerAmount: String(makerAmount),
    takerAmount: String(takerAmount),
    expiration: String(expiration),
    nonce: "0",
    feeRateBps: "0",
    side: side,
    signatureType: sigType,
    signature,
  };
}

/**
 * Get the CLOB token ID for a market's YES/NO outcome.
 * Fetches from the CLOB market endpoint by condition ID.
 */
export async function getClobTokenId(
  conditionId: string,
  outcome: "YES" | "NO"
): Promise<string | null> {
  try {
    const path = `/markets/${conditionId}`;
    const headers = await buildApiHeaders("GET", path);
    const res = await polyFetch(`${CLOB_API}${path}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`CLOB market fetch failed: ${res.status}`);
      return null;
    }
    const data = await res.json() as {
      tokens?: Array<{ token_id: string; outcome: string }>;
    };
    const token = data.tokens?.find(
      (t) => t.outcome?.toUpperCase() === outcome
    );
    return token?.token_id ?? null;
  } catch (err) {
    console.error("getClobTokenId error:", err);
    return null;
  }
}

/**
 * Build a fully-signed order + HMAC auth headers and return them WITHOUT sending.
 * The browser picks this up and POSTs directly to Polymarket from the user's
 * VPN-connected machine — bypassing Replit's datacenter IP restriction.
 */
export async function prepareOrderForBrowser(
  params: PlaceOrderParams
): Promise<PreparedBrowserOrder> {
  const wallet = getWallet();
  const eoaAddress = await wallet.getAddress();

  const signedOrder = await buildSignedOrder(params, wallet);
  // owner = the API key identifier (UUID from POLYMARKET_API_KEY env), matching how the
  // official @polymarket/clob-client sends this.creds.key in orderToJson().
  const apiKey = process.env.POLYMARKET_API_KEY ?? "";
  // deferExec: false matches official @polymarket/clob-client orderToJson() field order
  const body = JSON.stringify({ deferExec: false, order: signedOrder, owner: apiKey, orderType: "GTC" });
  const path = "/order";
  const headers = await buildApiHeaders("POST", path, body);

  return {
    id: crypto.randomUUID(),
    url: `${CLOB_API}${path}`,
    method: "POST",
    headers,
    body,
    meta: { direction: params.side, price: params.price, sizeUsdc: params.sizeUsdc },
  };
}

/**
 * Place a real order on Polymarket CLOB.
 */
export async function placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
  try {
    const wallet = getWallet();
    const eoaAddress = await wallet.getAddress();

    const signedOrder = await buildSignedOrder(params, wallet);

    // owner = API key UUID (matches this.creds.key in the official @polymarket/clob-client)
    const apiKey = process.env.POLYMARKET_API_KEY ?? "";
    const body = JSON.stringify({
      deferExec: false,
      order: signedOrder,
      owner: apiKey,
      orderType: "GTC", // Good Till Cancelled
    });

    const path = "/order";
    const headers = await buildApiHeaders("POST", path, body);

    const res = await polyFetch(`${CLOB_API}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });

    const responseText = await res.text();
    let responseJson: { orderID?: string; status?: string; errorMsg?: string } = {};
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      // non-JSON response
    }

    if (res.ok && responseJson.orderID) {
      console.log(`[LIVE ORDER] Placed ${params.side} ${params.sizeUsdc} USDC @ ${params.price} | ID: ${responseJson.orderID}`);
      return {
        success: true,
        orderId: responseJson.orderID,
        status: responseJson.status ?? "matched",
      };
    } else {
      const msg = responseJson.errorMsg ?? responseText ?? `HTTP ${res.status}`;
      console.error(`[LIVE ORDER] Failed: ${msg}`);
      return { success: false, errorMessage: msg };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[LIVE ORDER] Exception: ${msg}`);
    return { success: false, errorMessage: msg };
  }
}

/**
 * Cancel an open order.
 */
export async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    const body = JSON.stringify({ orderID: orderId });
    const path = "/order";
    const headers = await buildApiHeaders("DELETE", path, body);

    const res = await polyFetch(`${CLOB_API}${path}`, {
      method: "DELETE",
      headers,
      body,
      signal: AbortSignal.timeout(8000),
    });

    return res.ok;
  } catch {
    return false;
  }
}

// USDC.e (bridged USDC) contract on Polygon — what Polymarket holds for trading
const USDCE_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
// Native USDC on Polygon (fallback)
const USDC_POLYGON  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
// Public Polygon RPC endpoints (tried in order)
const POLYGON_RPCS  = [
  "https://rpc-mainnet.matic.quiknode.pro",
  "https://1rpc.io/matic",
  "https://rpc.ankr.com/polygon",
];

/**
 * Query ERC-20 balanceOf(address) via JSON-RPC on Polygon.
 */
async function erc20BalanceOf(token: string, holder: string): Promise<number | null> {
  const data = "0x70a08231" + holder.slice(2).toLowerCase().padStart(64, "0");
  for (const rpc of POLYGON_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to: token, data }, "latest"], id: 1 }),
        signal: AbortSignal.timeout(6000),
      });
      const json = await res.json() as { result?: string };
      if (json.result && json.result !== "0x") {
        return parseInt(json.result, 16) / 1e6; // USDC has 6 decimals
      }
    } catch { /* try next RPC */ }
  }
  return null;
}

/**
 * Get the effective USDC balance available for Polymarket trading.
 *
 * Polymarket stores USDC.e in the proxy wallet with max approval to the
 * CTF Exchange — so the on-chain proxy balance is the true trading budget.
 * The CLOB /balance-allowance endpoint reports "deposited into exchange" (0
 * when using wallet-based flow), so we read on-chain balance directly.
 */
export async function getWalletBalance(): Promise<number | null> {
  try {
    const proxyAddress = getProxyAddress();
    const holder = proxyAddress ?? (await getWallet().getAddress());

    // Try USDC.e first (Polymarket's primary collateral on Polygon)
    const usdce = await erc20BalanceOf(USDCE_POLYGON, holder);
    if (usdce !== null && usdce > 0) return usdce;

    // Fall back to native USDC
    const usdc = await erc20BalanceOf(USDC_POLYGON, holder);
    if (usdc !== null) return usdc;

    // Last resort: CLOB balance-allowance API
    const funderParam = proxyAddress ? `&funder=${proxyAddress}` : "";
    const fullPath = `/balance-allowance?asset_type=COLLATERAL&signature_type=2${funderParam}`;
    const headers = await buildApiHeaders("GET", `/balance-allowance`);
    const res = await polyFetch(`${CLOB_API}${fullPath}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json() as { balance?: string };
    return data.balance !== undefined ? parseFloat(data.balance) : null;
  } catch {
    return null;
  }
}
