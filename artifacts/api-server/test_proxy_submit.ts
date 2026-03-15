import { polyFetch, setProxyUrl } from './src/lib/proxiedFetch.js';

async function main() {
  // Set proxy from env
  const proxyUrl = process.env.PROXY_URL;
  if (proxyUrl) { setProxyUrl(proxyUrl); }
  
  const r1 = await fetch('http://localhost:8080/api/bot/pending-order');
  const data = await r1.json() as any;
  if (!data.pending) { console.log("No pending order"); return; }
  const p = data.pending;
  const parsed = JSON.parse(p.body);
  console.log("maker:", parsed.order.maker);
  console.log("signer:", parsed.order.signer);
  console.log("owner:", parsed.owner);
  console.log("sig:", parsed.order.signature.slice(0,20) + "...");
  
  console.log("\nSubmitting via proxy...");
  const r2 = await polyFetch(p.url, {
    method: p.method,
    headers: p.headers,
    body: p.body,
    signal: AbortSignal.timeout(15000),
  });
  const t = await r2.text();
  console.log("→", r2.status, ":", t.slice(0, 300));
}
main().catch(console.error);
