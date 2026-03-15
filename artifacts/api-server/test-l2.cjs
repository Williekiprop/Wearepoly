(async () => {
  const crypto = require('crypto');
  const CLOB_API = "https://clob.polymarket.com";
  
  const key = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE;
  const walletPk = process.env.POLYMARKET_WALLET_KEY;
  
  if (!key || !secret || !passphrase || !walletPk) {
    console.error("Missing env vars"); process.exit(1);
  }
  
  const { ethers } = require('ethers');
  const wallet = new ethers.Wallet(walletPk.startsWith("0x") ? walletPk : "0x" + walletPk);
  const address = await wallet.getAddress();
  
  console.log("Testing L2 auth with API key:", key);
  console.log("Wallet address:", address);
  
  const ts = Math.floor(Date.now() / 1000);
  const path = "/auth/api-key";
  const message = `${ts}GET${path}`;
  const secretBuf = Buffer.from(secret.replace(/-/g,"+").replace(/_/g,"/"), "base64");
  const sig = crypto.createHmac("sha256", secretBuf).update(message).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_");
  
  const headers = {
    "POLY_ADDRESS": address,
    "POLY_API_KEY": key,
    "POLY_SIGNATURE": sig,
    "POLY_TIMESTAMP": String(ts),
    "POLY_PASSPHRASE": passphrase,
  };
  
  console.log("\nTesting GET /auth/api-key (L2)...");
  const res = await fetch(CLOB_API + path, { headers });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Body:", text.slice(0, 200));
  
  if (res.ok) {
    console.log("\n✓ L2 auth WORKING! Bot can now trade.");
    
    // Also test balance endpoint
    const ts2 = Math.floor(Date.now() / 1000);
    const balPath = `/balance-allowance?asset_type=USDC&signature_type=0`;
    const msg2 = `${ts2}GET${balPath}`;
    const sig2 = crypto.createHmac("sha256", secretBuf).update(msg2).digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_");
    const r2 = await fetch(CLOB_API + balPath, { headers: {
      "POLY_ADDRESS": address,
      "POLY_API_KEY": key,
      "POLY_SIGNATURE": sig2,
      "POLY_TIMESTAMP": String(ts2),
      "POLY_PASSPHRASE": passphrase,
    }});
    const t2 = await r2.text();
    console.log("\nBalance endpoint:", r2.status, t2.slice(0, 200));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
