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
  tokenId: string;        // CLOB token ID for the YES or NO outcome
  side: "BUY" | "SELL";
  price: number;          // 0.0 to 1.0
  sizeUsdc: number;       // USDC amount to spend (BUY) or expected to receive (SELL)
  sizeTokens?: number;    // SELL only: exact number of tokens to sell (overrides sizeUsdc for amount calc)
  feeRateBps?: number;    // maker fee rate in basis points (default 1000 = 10%, required for BTC 5m markets)
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
  meta: { direction: string; price: number; sizeUsdc: number; actualSizeUsdc: number };
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
  // Default to 1000 bps (10%) — required for BTC 5-minute markets. Other markets typically use 0.
  const feeRateBps = params.feeRateBps ?? 1000;
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

  // Polymarket requires prices on the 0.01 tick grid (1-cent increments).
  // Snap to nearest 0.01 to satisfy the CLOB's minimum tick-size check.
  const price = Math.round(params.price * 100) / 100;
  if (price <= 0 || price >= 1) throw new Error(`Price out of range after tick snap: ${price}`);
  if (Math.abs(price - params.price) > 1e-9) {
    console.log(`[ORDER] Price snapped ${params.price} → ${price} (tick grid 0.01)`);
  }

  // Polymarket CLOB amount precision rules (enforced server-side):
  //
  // BUY:  maker = USDC in,   taker = tokens out
  //   takerAmount (tokens): max 2 decimal places  → micro-token must be divisible by 10,000
  //   makerAmount (USDC):   max 4 decimal places  → micro-USDC must be divisible by 100
  //
  //   The CLOB also validates that the effective price (makerAmount / takerAmount) lands
  //   exactly on the 0.01 tick grid. To guarantee this, we use WHOLE token quantities
  //   (0 decimals) and derive USDC = price × tokens — which is always exact when
  //   price is on the 0.01 grid and tokens is an integer.
  //
  // SELL: same rule flipped — integer maker-tokens, derived taker-USDC.

  let makerAmount: number;
  let takerAmount: number;

  if (side === "BUY") {
    // BUY: pay USDC (maker), receive tokens (taker)
    // Use whole token quantities so derived price = makerUsdc/takerTokens = price exactly.
    const takerTokens = Math.ceil(sizeUsdc / price);
    const makerUsdc   = price * takerTokens;              // exact (0.01 × integer = 2dp USDC)
    takerAmount = takerTokens * 1_000_000;                // micro-tokens, divisible by 10,000 ✓ (integer)
    makerAmount = Math.round(makerUsdc * 1_000_000);      // micro-USDC, divisible by 100 ✓ (2dp × 10^6)
  } else {
    // SELL: give tokens (maker), receive USDC (taker)
    const rawTokens   = params.sizeTokens ?? Math.floor(sizeUsdc / price);
    const makerTokens = Math.max(1, Math.floor(rawTokens));
    const takerUsdc   = price * makerTokens;              // exact (same logic as BUY)
    makerAmount = makerTokens * 1_000_000;                // micro-tokens, divisible by 10,000 ✓
    takerAmount = Math.round(takerUsdc * 1_000_000);      // micro-USDC, divisible by 100 ✓
  }

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
    feeRateBps: BigInt(feeRateBps),
    side: sideInt,
    signatureType: sigType,
  };

  // EOA signs the EIP-712 order hash directly using standard signTypedData.
  // For signatureType=2 (POLY_GNOSIS_SAFE), the CLOB validates off-chain as:
  //   ecrecover(orderHash, sig) == proxy.owner (EOA)
  // This is identical to signatureType=0; the CLOB knows the proxy<>EOA relationship.
  const signature = await wallet.signTypedData(DOMAIN, ORDER_TYPES, orderData);

  console.log(`[ORDER] signatureType=${sigType} maker=${makerAddress} signer=${signerAddress} eoaSigner=${eoaAddress} feeRateBps=${feeRateBps}`);

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
    feeRateBps: String(feeRateBps),
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
    // CLOB market data is public — use plain fetch (no proxy, no auth required)
    const res = await fetch(`${CLOB_API}${path}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`CLOB market fetch failed: ${res.status}`);
      return null;
    }
    const data = await res.json() as {
      tokens?: Array<{ token_id: string; outcome: string }>;
    };
    // BTC 5-min markets use "UP"/"DOWN" outcomes on Polymarket CLOB,
    // but internally we track them as YES=UP, NO=DOWN.
    // Search both labels so this works regardless of market naming convention.
    const wantUp = outcome === "YES";
    const aliases = wantUp ? ["YES", "UP"] : ["NO", "DOWN"];
    const token = data.tokens?.find(
      (t) => aliases.includes(t.outcome?.toUpperCase())
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

  // Extract actual USDC cost from the signed order (makerAmount is USDC for BUY, tokens for SELL)
  const orderObj = signedOrder as Record<string, string | number>;
  const actualSizeUsdc = params.side === "BUY"
    ? Number(orderObj.makerAmount) / 1_000_000   // micro-USDC → USDC
    : params.sizeUsdc;                            // SELL: sizeUsdc is approximate, tokens side is maker

  return {
    id: crypto.randomUUID(),
    url: `${CLOB_API}${path}`,
    method: "POST",
    headers,
    body,
    meta: { direction: params.side, price: params.price, sizeUsdc: params.sizeUsdc, actualSizeUsdc },
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
  "https://polygon-bor-rpc.publicnode.com",
  "https://rpc.ankr.com/polygon",
  "https://1rpc.io/matic",
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

// ─────────────────────────────────────────────────────────────────────────────
// CTF Redemption — claim winning tokens back to USDC after market resolution
// ─────────────────────────────────────────────────────────────────────────────

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // ConditionalTokens on Polygon
const CTF_REDEEM_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
];
const SAFE_EXEC_ABI = [
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes memory signatures) external payable returns (bool success)",
  "function nonce() external view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) external view returns (bytes32)",
];

/**
 * Attempt to redeem winning CTF tokens back to USDC.e via the proxy Safe wallet.
 * Executes a Safe transaction (signed by the EOA owner) to call
 * ConditionalTokens.redeemPositions([1,2]) — both indexSets so we always
 * capture the winning side without needing to know which one won.
 *
 * Requires MATIC in the EOA wallet for gas. Silently fails if unavailable
 * (Polymarket auto-redeems within a few minutes anyway).
 */
export async function redeemWinningPositions(conditionId: string): Promise<boolean> {
  try {
    const proxyAddress = getProxyAddress();
    if (!proxyAddress) {
      console.warn("[REDEEM] No proxy address — skipping on-chain redemption");
      return false;
    }

    const wallet = getWallet();
    // Use multiple RPCs for resilience
    const POLYGON_RPCS = [
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon-rpc.com",
    ];

    let provider: ethers.JsonRpcProvider | null = null;
    for (const rpc of POLYGON_RPCS) {
      try {
        provider = new ethers.JsonRpcProvider(rpc);
        await provider.getBlockNumber(); // smoke test
        break;
      } catch {
        provider = null;
      }
    }
    if (!provider) {
      console.warn("[REDEEM] All Polygon RPCs failed — skipping redemption");
      return false;
    }

    const signer = wallet.connect(provider);

    // Encode the redeemPositions call data
    const ctfIface = new ethers.Interface(CTF_REDEEM_ABI);
    const callData = ctfIface.encodeFunctionData("redeemPositions", [
      USDCE_POLYGON,
      ethers.ZeroHash, // parentCollectionId = bytes32(0) for top-level positions
      conditionId,
      [1n, 2n], // YES (indexSet=1) and NO (indexSet=2) — winning one returns USDC, losing returns 0
    ]);

    const safe = new ethers.Contract(proxyAddress, SAFE_EXEC_ABI, signer);

    // Get current nonce of the Safe
    const nonce: bigint = await safe.nonce();

    // Ask the Safe for the EIP-712 transaction hash
    const safeTxHash: string = await safe.getTransactionHash(
      CTF_ADDRESS,    // to
      0n,             // value
      callData,       // data
      0,              // operation: CALL
      0n,             // safeTxGas (let node estimate)
      0n,             // baseGas
      0n,             // gasPrice
      ethers.ZeroAddress, // gasToken
      ethers.ZeroAddress, // refundReceiver
      nonce,
    );

    // Sign the Safe transaction hash raw (no Ethereum personal_sign prefix)
    const rawSig = signer.signingKey.sign(safeTxHash);
    const signature = ethers.concat([rawSig.r, rawSig.s, ethers.toBeHex(rawSig.v, 1)]);

    console.log(`[REDEEM] Submitting CTF redeemPositions for ${conditionId.substring(0, 10)}...`);
    const tx = await safe.execTransaction(
      CTF_ADDRESS, 0n, callData,
      0, 0n, 0n, 0n,
      ethers.ZeroAddress, ethers.ZeroAddress,
      signature,
      { gasLimit: 400_000n },
    );
    console.log(`[REDEEM] Tx submitted: ${tx.hash}`);
    const receipt = await tx.wait(1);
    console.log(`[REDEEM] Confirmed block ${receipt.blockNumber} — USDC returned to wallet`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[REDEEM] On-chain redemption failed (auto-redeem will occur later): ${msg.substring(0, 120)}`);
    return false;
  }
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
